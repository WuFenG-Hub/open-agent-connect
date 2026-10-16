"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRootOwnerResolver = createRootOwnerResolver;
// Root-owner resolution: walk the /info/owner chain upward from any
// GlobalMetaID — Bot -> Device -> Owner, at most `maxHops` hops (default 2,
// per the trust tiers design) — verifying every hop offline with
// verifyOwnerBinding. The terminal verified gmid is the root owner:
//   - Bot bound to a device bound to an owner  -> the owner.
//   - Bot bound to an unbound device (legacy)  -> the device itself,
//     reproducing today's Bot->Device behavior exactly.
//   - No pin / unbound / invalid signature     -> the walk terminates at
//     that subject (never past an unverifiable link).
// Resolutions are cached per subject gmid (trustCacheStore) together with
// the pinId they are based on; a cache hit inside the TTL is served without
// any chain read, and `invalidate`/`forceRefresh` drop entries when a
// binding change is known to have landed.
const deriveIdentity_1 = require("../identity/deriveIdentity");
const ownerBinding_1 = require("../owner/ownerBinding");
const ownerPinRead_1 = require("./ownerPinRead");
const trustCacheStore_1 = require("./trustCacheStore");
const DEFAULT_MAX_HOPS = 2;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
async function walkOwnerChain(startGmid, maxHops, pinReader) {
    const chain = [];
    const observedPins = [];
    let subject = startGmid;
    for (let hop = 0; hop < maxHops; hop += 1) {
        let pin = null;
        try {
            pin = await pinReader(subject);
        }
        catch {
            // A read failure is not proof of absence, but the conservative
            // direction for trust is to stop the walk at the last verified link.
            pin = null;
        }
        observedPins.push({ subjectGmid: subject, pin });
        if (!pin || !pin.payload)
            break;
        const payload = (0, ownerBinding_1.parseOwnerBindingPayload)(pin.payload);
        if (!payload)
            break; // empty / malformed payload = unbound
        if (!(0, ownerBinding_1.verifyOwnerBinding)(pin.payload, subject))
            break; // unverifiable link terminates the walk
        chain.push({ subjectGmid: subject, ownerGmid: payload.owner, pinId: pin.pinId });
        subject = payload.owner;
    }
    return {
        rootOwnerGlobalMetaId: chain.length > 0 ? chain[chain.length - 1].ownerGmid : startGmid,
        chain,
        observedPins,
    };
}
function createRootOwnerResolver(input = {}) {
    const maxHops = Math.max(1, Math.floor(input.maxHops ?? DEFAULT_MAX_HOPS));
    const cacheTtlMs = input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const now = input.now ?? (() => Date.now());
    const pinReader = input.pinReader ?? (0, ownerPinRead_1.createOwnerPinReader)();
    const cache = input.cache
        ?? (input.systemHomeDir ? (0, trustCacheStore_1.createTrustCacheStore)(input.systemHomeDir) : createMemoryTrustCacheStore());
    async function resolve(globalMetaId, requestedHops, forceRefresh) {
        const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(globalMetaId);
        if (!normalized) {
            throw new Error(`Invalid GlobalMetaID: ${String(globalMetaId)}`);
        }
        if (!forceRefresh) {
            const cached = await cache.get(normalized);
            if (cached && now() - Date.parse(cached.resolvedAt) < cacheTtlMs) {
                // Truncate to the requested hop count: a 2-hop cache entry still
                // answers a 1-hop resolveDeviceOwner with just the first link.
                const chain = cached.chain.slice(0, requestedHops);
                return {
                    rootOwnerGlobalMetaId: chain.length > 0 ? chain[chain.length - 1].ownerGmid : normalized,
                    chain,
                    fromCache: true,
                };
            }
        }
        const outcome = await walkOwnerChain(normalized, requestedHops, pinReader);
        const resolvedAt = new Date(now()).toISOString();
        // Cache every walked subject: each entry stores the full remaining chain
        // so resolving a Bot later also serves direct Device-level lookups.
        for (let index = 0; index < outcome.observedPins.length; index += 1) {
            const { subjectGmid, pin } = outcome.observedPins[index];
            const entry = {
                subjectGlobalMetaId: subjectGmid,
                pinId: pin ? pin.pinId : null,
                rootOwnerGlobalMetaId: outcome.chain.length > index
                    ? outcome.chain[outcome.chain.length - 1].ownerGmid
                    : subjectGmid,
                chain: outcome.chain.slice(index),
                resolvedAt,
            };
            await cache.set(entry);
        }
        return {
            rootOwnerGlobalMetaId: outcome.rootOwnerGlobalMetaId,
            chain: outcome.chain,
            fromCache: false,
        };
    }
    return {
        async resolveRootOwner(globalMetaId, options = {}) {
            const resolution = await resolve(globalMetaId, maxHops, options.forceRefresh === true);
            return {
                rootOwnerGlobalMetaId: resolution.rootOwnerGlobalMetaId,
                chain: resolution.chain,
                fromCache: resolution.fromCache,
            };
        },
        async resolveDeviceOwner(globalMetaId, options = {}) {
            const resolution = await resolve(globalMetaId, 1, options.forceRefresh === true);
            return {
                deviceOwnerGlobalMetaId: resolution.rootOwnerGlobalMetaId,
                chain: resolution.chain,
                fromCache: resolution.fromCache,
            };
        },
        async invalidate(globalMetaId) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(globalMetaId);
            if (!normalized)
                return;
            await cache.invalidate(normalized);
        },
    };
}
/** Fallback when neither systemHomeDir nor a cache is provided (library/test use). */
function createMemoryTrustCacheStore() {
    const entries = new Map();
    const grants = new Map();
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
