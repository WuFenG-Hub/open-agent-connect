// Trusted-owner resolution: fold an owner's /protocols/simpletrust pins
// into the effective trust set (grants minus revokes, per pinId) — see
// docs/metaid_protocols/09-simpletrust.md. Resolution is what a peer device
// runs to answer "is my root owner's peer in my owner's trust grants?"
// (the `trusted` trust tier, P3).
//
// Like the P1 root-owner resolver: reads are injectable for tests, results
// are cached machine-wide per owner gmid together with the newest pinId the
// fold is based on; a cache hit inside the TTL performs zero chain reads,
// and `invalidate`/`forceRefresh` drop entries after a local publish.
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { createOwnerPathPinLister, type AuthorPathPin, type OwnerPathPinLister } from './ownerPinRead';
import { parseSimpletrustPin, SIMPLETRUST_PATH } from './trustGrantPins';
import {
  createTrustCacheStore,
  type ResolvedTrustGrant,
  type TrustCacheStore,
  type TrustGrantCacheEntry,
} from './trustCacheStore';

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export interface TrustedOwnersResolution {
  trustedOwners: ResolvedTrustGrant[];
  /** True when served from the trust cache without any chain read. */
  fromCache: boolean;
}

export interface TrustedOwnerResolver {
  resolveTrustedOwners(ownerGlobalMetaId: string, options?: { forceRefresh?: boolean }): Promise<TrustedOwnersResolution>;
  /** Drop one owner's cached grant resolution (right after publishing a grant/revoke). */
  invalidate(ownerGlobalMetaId: string): Promise<void>;
}

export interface CreateTrustedOwnerResolverInput {
  /** Needed for the default cache store; omit when a custom `cache` is given. */
  systemHomeDir?: string;
  /** Test seam: inject a fake pin lister. Defaults to the MANAPI lister. */
  pinLister?: OwnerPathPinLister;
  /** Test seam: inject a cache store (e.g. over a temp home). */
  cache?: TrustCacheStore;
  cacheTtlMs?: number;
  /** Test seam: clock override. */
  now?: () => number;
}

/**
 * Pure grants-minus-revokes fold over the author's pins (any order; sorted
 * newest-first by the reader). Rules:
 *   - grants whose pinId is named by any revoke pin are cancelled;
 *   - a revoke naming an unknown pinId cancels nothing (no-op, still audit);
 *   - duplicate grants to the same owner collapse to ONE entry — the newest
 *     grant's note/ts/grantPinId wins (list is newest-first, first wins);
 *   - malformed payloads are skipped.
 */
export function computeEffectiveTrustGrants(pins: AuthorPathPin[]): ResolvedTrustGrant[] {
  const revokedPinIds = new Set<string>();
  for (const pin of pins) {
    if (!pin.payload) continue;
    const parsed = parseSimpletrustPin(pin.payload);
    if (parsed?.kind === 'revoke') revokedPinIds.add(parsed.revoke);
  }
  const byOwner = new Map<string, ResolvedTrustGrant>();
  const ordered = [...pins].sort((a, b) => (b.timestamp - a.timestamp) || a.pinId.localeCompare(b.pinId));
  for (const pin of ordered) {
    if (revokedPinIds.has(pin.pinId)) continue;
    if (!pin.payload) continue;
    const parsed = parseSimpletrustPin(pin.payload);
    if (parsed?.kind !== 'grant') continue;
    if (byOwner.has(parsed.trustedOwner)) continue; // newest grant already recorded
    byOwner.set(parsed.trustedOwner, {
      trustedOwner: parsed.trustedOwner,
      ...(parsed.note ? { note: parsed.note } : {}),
      ts: parsed.ts,
      grantPinId: pin.pinId,
    });
  }
  return [...byOwner.values()].sort((a, b) => a.trustedOwner.localeCompare(b.trustedOwner));
}

export function createTrustedOwnerResolver(input: CreateTrustedOwnerResolverInput = {}): TrustedOwnerResolver {
  const cacheTtlMs = input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = input.now ?? (() => Date.now());
  const pinLister: OwnerPathPinLister = input.pinLister ?? createOwnerPathPinLister();
  const cache: TrustCacheStore = input.cache
    ?? (input.systemHomeDir ? createTrustCacheStore(input.systemHomeDir) : createMemoryTrustCacheStore());

  return {
    async resolveTrustedOwners(ownerGlobalMetaId, options = {}) {
      const normalized = normalizeGlobalMetaId(ownerGlobalMetaId);
      if (!normalized) {
        throw new Error(`Invalid GlobalMetaID: ${String(ownerGlobalMetaId)}`);
      }

      if (options.forceRefresh !== true) {
        const cached = await cache.getGrants(normalized);
        if (cached && now() - Date.parse(cached.resolvedAt) < cacheTtlMs) {
          return { trustedOwners: cached.trustedOwners, fromCache: true };
        }
      }

      let pins: AuthorPathPin[] = [];
      try {
        pins = await pinLister(normalized, SIMPLETRUST_PATH);
      } catch {
        // A read failure resolves to the empty set (the conservative
        // direction for trust), bounded by the TTL.
        pins = [];
      }
      const ordered = [...pins].sort((a, b) => (b.timestamp - a.timestamp) || a.pinId.localeCompare(b.pinId));
      const trustedOwners = computeEffectiveTrustGrants(pins);
      const newestPinId = ordered.length > 0 ? ordered[0].pinId : null;
      const entry: TrustGrantCacheEntry = {
        ownerGlobalMetaId: normalized,
        pinId: newestPinId,
        trustedOwners,
        resolvedAt: new Date(now()).toISOString(),
      };
      await cache.setGrants(entry);
      return { trustedOwners, fromCache: false };
    },
    async invalidate(ownerGlobalMetaId) {
      const normalized = normalizeGlobalMetaId(ownerGlobalMetaId);
      if (!normalized) return;
      await cache.invalidateGrants(normalized);
    },
  };
}

/** Fallback when neither systemHomeDir nor a cache is provided (library/test use). */
function createMemoryTrustCacheStore(): TrustCacheStore {
  const entries = new Map<string, import('./trustCacheStore').TrustCacheEntry>();
  const grants = new Map<string, TrustGrantCacheEntry>();
  return {
    async get(subjectGlobalMetaId) {
      return entries.get(subjectGlobalMetaId) ?? null;
    },
    async set(entry) {
      entries.set(entry.subjectGlobalMetaId, entry);
    },
    async invalidate(subjectGlobalMetaId) {
      entries.delete(subjectGlobalMetaId);
    },
    async getGrants(ownerGlobalMetaId) {
      return grants.get(ownerGlobalMetaId) ?? null;
    },
    async setGrants(entry) {
      grants.set(entry.ownerGlobalMetaId, entry);
    },
    async invalidateGrants(ownerGlobalMetaId) {
      grants.delete(ownerGlobalMetaId);
    },
    async clear() {
      entries.clear();
      grants.clear();
    },
  };
}
