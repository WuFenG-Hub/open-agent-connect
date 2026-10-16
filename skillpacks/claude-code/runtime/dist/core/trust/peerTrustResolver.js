"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPeerTrustResolver = createPeerTrustResolver;
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
const deriveIdentity_1 = require("../identity/deriveIdentity");
const identityProfiles_1 = require("../identity/identityProfiles");
const ownerIdentity_1 = require("../owner/ownerIdentity");
const contactEvidence_1 = require("./contactEvidence");
const rootOwnerResolver_1 = require("./rootOwnerResolver");
const trustedOwnerResolver_1 = require("./trustedOwnerResolver");
const trustLocalStore_1 = require("./trustLocalStore");
const teamRegistryStore_1 = require("./teamRegistryStore");
const DEFAULT_TIER_CACHE_TTL_MS = 60_000;
function createPeerTrustResolver(input) {
    const systemHomeDir = input.systemHomeDir;
    const tierCacheTtlMs = input.tierCacheTtlMs ?? DEFAULT_TIER_CACHE_TTL_MS;
    const now = input.now ?? (() => Date.now());
    const rootOwnerResolver = input.rootOwnerResolver ?? (0, rootOwnerResolver_1.createRootOwnerResolver)({ systemHomeDir });
    const trustedOwnerResolver = input.trustedOwnerResolver
        ?? (0, trustedOwnerResolver_1.createTrustedOwnerResolver)({ systemHomeDir });
    const contactEvidence = input.contactEvidence ?? contactEvidence_1.hasTwoWayExchange;
    const listLocalProfileGmids = input.listLocalProfileGmids
        ?? (async () => {
            const profiles = await (0, identityProfiles_1.listIdentityProfiles)(systemHomeDir).catch(() => []);
            return profiles
                .map((profile) => (0, deriveIdentity_1.normalizeGlobalMetaId)(profile.globalMetaId))
                .filter((gmid) => gmid !== null);
        });
    // In-process tier memo: key = `${profileHomeDir ?? '*'}|${peerGmid}`.
    const tierCache = new Map();
    // Best-effort team-registry upsert (P5): records a freshly resolved team
    // peer as an 'auto' entry so discovery/seating surfaces can propose it.
    // Skips the write when the gmid is already recorded.
    async function recordTeamPeer(peer) {
        const store = (0, teamRegistryStore_1.createTeamRegistryStore)(systemHomeDir);
        const entries = await store.list();
        if (entries.some((entry) => entry.globalMetaId === peer))
            return;
        await store.upsert({
            globalMetaId: peer,
            source: 'auto',
            addedAt: new Date(now()).toISOString(),
        });
    }
    function cacheKey(profileHomeDir, peer) {
        return `${profileHomeDir ?? '*'}|${peer}`;
    }
    async function computeTier(peer, profileHomeDir, contacts) {
        // Local tier: the peer is one of this device's own profiles.
        const localGmids = await listLocalProfileGmids();
        if (localGmids.includes(peer)) {
            return 'local';
        }
        // My root owner: walk from the device identity; an unbound device is its
        // own root owner, which reproduces the legacy one-device team.
        const device = await (0, ownerIdentity_1.readOwnerIdentity)(systemHomeDir).catch(() => null);
        const myRootOwner = device
            ? (0, deriveIdentity_1.normalizeGlobalMetaId)((await rootOwnerResolver.resolveRootOwner(device.globalMetaId)).rootOwnerGlobalMetaId)
            : null;
        // Team: the peer's root owner is my root owner.
        const peerRootOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)((await rootOwnerResolver.resolveRootOwner(peer)).rootOwnerGlobalMetaId);
        if (myRootOwner && peerRootOwner === myRootOwner) {
            // Auto-record team peers in the registry (P5): a convenience for
            // discovery/seating. Best-effort by contract — a registry failure must
            // never break tier resolution.
            await recordTeamPeer(peer).catch(() => undefined);
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
            const peer = (0, deriveIdentity_1.normalizeGlobalMetaId)(resolveInput.peerGlobalMetaId);
            if (!peer) {
                throw new Error(`Invalid GlobalMetaID: ${String(resolveInput.peerGlobalMetaId)}`);
            }
            // Blocked wins over everything and is never served from cache.
            const localState = await (0, trustLocalStore_1.createTrustLocalStore)(systemHomeDir).read();
            if (localState.blocked.includes(peer)) {
                tierCache.delete(cacheKey(resolveInput.profileHomeDir, peer));
                return 'blocked';
            }
            const key = cacheKey(resolveInput.profileHomeDir, peer);
            const cached = tierCache.get(key);
            if (cached && cached.expiresAt > now()) {
                // A fresh contact mark promotes immediately even inside the TTL.
                if (localState.contacts.includes(peer))
                    return 'contact';
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
            const peer = (0, deriveIdentity_1.normalizeGlobalMetaId)(peerGlobalMetaId);
            if (!peer)
                return;
            for (const key of [...tierCache.keys()]) {
                if (key.endsWith(`|${peer}`)) {
                    tierCache.delete(key);
                }
            }
        },
    };
}
