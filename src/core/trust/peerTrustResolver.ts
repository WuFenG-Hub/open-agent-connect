// Peer trust-tier resolution (trust tiers P3): maps any peer GlobalMetaID
// to its tier following the spec precedence EXACTLY:
//
//   blocked  — on the device blocklist; wins over every other tier. The
//              blocklist is re-read from disk on EVERY resolution, so a block
//              takes effect immediately, never bounded by a cache TTL.
//   local    — the peer is a profile on this device.
//   team     — peer's root owner == my root owner, where my root owner is
//              resolved by walking from the DEVICE identity (terminating at
//              the device itself when unbound — legacy installs then form a
//              one-device team).
//   trusted  — peer's root owner is in my root owner's on-chain trust grants.
//   contact  — explicit contacts mark, or a completed two-way private-chat
//              exchange in the given profile.
//   stranger — none of the above.
//
// The blocklist/contacts reads are always fresh; the expensive chain parts
// (root-owner walks, grant folds) are already cached in the P1/P2 resolvers,
// and the resulting tier is memoized here in a short-TTL in-process cache
// keyed (profileHomeDir || '*', peerGmid). `invalidate` drops entries after
// trust-configuration changes (grants, blocks, contacts).
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { listIdentityProfiles } from '../identity/identityProfiles';
import { readOwnerIdentity } from '../owner/ownerIdentity';
import { hasTwoWayExchange } from './contactEvidence';
import type { PeerTrustTier } from './capabilityClasses';
import { createRootOwnerResolver, type RootOwnerResolver } from './rootOwnerResolver';
import { createTrustedOwnerResolver, type TrustedOwnerResolver } from './trustedOwnerResolver';
import { createTrustLocalStore } from './trustLocalStore';

const DEFAULT_TIER_CACHE_TTL_MS = 60_000;

export interface ResolvePeerTrustTierInput {
  peerGlobalMetaId: string;
  /** Profile home used for contact-evidence lookup (two-way chat exchange). */
  profileHomeDir?: string;
  /** Defaults to the gmids registered in the device profile manager. */
  localProfileGmids?: string[];
}

export interface PeerTrustTierResolver {
  resolvePeerTrustTier(input: ResolvePeerTrustTierInput): Promise<PeerTrustTier>;
  /** Drop cached tiers: one peer, or everything when omitted. */
  invalidate(peerGlobalMetaId?: string): void;
}

export interface CreatePeerTrustResolverInput {
  /** Anchors the blocklist, the device identity, and the default caches. */
  systemHomeDir: string;
  /** Test seams — default to the real P1/P2 resolvers over systemHomeDir. */
  rootOwnerResolver?: RootOwnerResolver;
  trustedOwnerResolver?: TrustedOwnerResolver;
  contactEvidence?: (profileHomeDir: string, peerGlobalMetaId: string) => Promise<boolean>;
  listLocalProfileGmids?: () => Promise<string[]>;
  tierCacheTtlMs?: number;
  now?: () => number;
}

export function createPeerTrustResolver(input: CreatePeerTrustResolverInput): PeerTrustTierResolver {
  const systemHomeDir = input.systemHomeDir;
  const tierCacheTtlMs = input.tierCacheTtlMs ?? DEFAULT_TIER_CACHE_TTL_MS;
  const now = input.now ?? (() => Date.now());
  const rootOwnerResolver: RootOwnerResolver = input.rootOwnerResolver ?? createRootOwnerResolver({ systemHomeDir });
  const trustedOwnerResolver: TrustedOwnerResolver = input.trustedOwnerResolver
    ?? createTrustedOwnerResolver({ systemHomeDir });
  const contactEvidence = input.contactEvidence ?? hasTwoWayExchange;
  const listLocalProfileGmids = input.listLocalProfileGmids
    ?? (async () => {
      const profiles = await listIdentityProfiles(systemHomeDir).catch(() => []);
      return profiles
        .map((profile) => normalizeGlobalMetaId(profile.globalMetaId))
        .filter((gmid): gmid is string => gmid !== null);
    });

  // In-process tier memo: key = `${profileHomeDir ?? '*'}|${peerGmid}`.
  const tierCache = new Map<string, { tier: PeerTrustTier; expiresAt: number }>();

  function cacheKey(profileHomeDir: string | undefined, peer: string): string {
    return `${profileHomeDir ?? '*'}|${peer}`;
  }

  async function computeTier(peer: string, profileHomeDir: string | undefined, contacts: string[]): Promise<PeerTrustTier> {
    // Local tier: the peer is one of this device's own profiles.
    const localGmids = await listLocalProfileGmids();
    if (localGmids.includes(peer)) {
      return 'local';
    }

    // My root owner: walk from the device identity; an unbound device is its
    // own root owner, which reproduces the legacy one-device team.
    const device = await readOwnerIdentity(systemHomeDir).catch(() => null);
    const myRootOwner = device
      ? normalizeGlobalMetaId(
        (await rootOwnerResolver.resolveRootOwner(device.globalMetaId)).rootOwnerGlobalMetaId,
      )
      : null;

    // Team: the peer's root owner is my root owner.
    const peerRootOwner = normalizeGlobalMetaId(
      (await rootOwnerResolver.resolveRootOwner(peer)).rootOwnerGlobalMetaId,
    );
    if (myRootOwner && peerRootOwner === myRootOwner) {
      return 'team';
    }

    // Trusted: the peer's root owner is in my owner's on-chain trust grants.
    if (myRootOwner) {
      const grants = await trustedOwnerResolver.resolveTrustedOwners(myRootOwner);
      if (grants.trustedOwners.some((grant) => grant.trustedOwner === peerRootOwner)) {
        return 'trusted';
      }
    }

    // Contact: explicit mark (fresh-read) or two-way chat evidence.
    if (contacts.includes(peer)) {
      return 'contact';
    }
    if (profileHomeDir && await contactEvidence(profileHomeDir, peer)) {
      return 'contact';
    }

    return 'stranger';
  }

  return {
    async resolvePeerTrustTier(resolveInput) {
      const peer = normalizeGlobalMetaId(resolveInput.peerGlobalMetaId);
      if (!peer) {
        throw new Error(`Invalid GlobalMetaID: ${String(resolveInput.peerGlobalMetaId)}`);
      }

      // Blocked wins over everything and is never served from cache.
      const localState = await createTrustLocalStore(systemHomeDir).read();
      if (localState.blocked.includes(peer)) {
        tierCache.delete(cacheKey(resolveInput.profileHomeDir, peer));
        return 'blocked';
      }

      const key = cacheKey(resolveInput.profileHomeDir, peer);
      const cached = tierCache.get(key);
      if (cached && cached.expiresAt > now()) {
        // A fresh contact mark promotes immediately even inside the TTL.
        if (localState.contacts.includes(peer)) return 'contact';
        return cached.tier;
      }

      const tier = await computeTier(peer, resolveInput.profileHomeDir, localState.contacts);
      tierCache.set(key, { tier, expiresAt: now() + tierCacheTtlMs });
      return tier;
    },
    invalidate(peerGlobalMetaId) {
      if (!peerGlobalMetaId) {
        tierCache.clear();
        return;
      }
      const peer = normalizeGlobalMetaId(peerGlobalMetaId);
      if (!peer) return;
      for (const key of [...tierCache.keys()]) {
        if (key.endsWith(`|${peer}`)) {
          tierCache.delete(key);
        }
      }
    },
  };
}
