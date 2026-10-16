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
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { parseOwnerBindingPayload, verifyOwnerBinding } from '../owner/ownerBinding';
import { createOwnerPinReader, type LatestOwnerPin, type OwnerPinReader } from './ownerPinRead';
import { createTrustCacheStore, type TrustCacheEntry, type TrustCacheStore, type TrustChainLink } from './trustCacheStore';

const DEFAULT_MAX_HOPS = 2;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export interface RootOwnerResolution {
  rootOwnerGlobalMetaId: string;
  chain: TrustChainLink[];
  /** True when served from the trust cache without any chain read. */
  fromCache: boolean;
}

export interface DeviceOwnerResolution {
  /** The identity one hop up from the subject (for a Bot: its Device). */
  deviceOwnerGlobalMetaId: string;
  chain: TrustChainLink[];
  fromCache: boolean;
}

export interface RootOwnerResolver {
  resolveRootOwner(globalMetaId: string, options?: { forceRefresh?: boolean }): Promise<RootOwnerResolution>;
  /** One hop up (Bot -> its directly accountable identity, usually the Device). */
  resolveDeviceOwner(globalMetaId: string, options?: { forceRefresh?: boolean }): Promise<DeviceOwnerResolution>;
  /** Drop cached state for one subject (e.g. right after re-publishing its binding). */
  invalidate(globalMetaId: string): Promise<void>;
}

export interface CreateRootOwnerResolverInput {
  /** Needed for the default cache store; omit when a custom `cache` is given. */
  systemHomeDir?: string;
  /** Test seam: inject a fake pin reader. Defaults to the MANAPI reader. */
  pinReader?: OwnerPinReader;
  /** Test seam: inject a cache store (e.g. over a temp home). */
  cache?: TrustCacheStore;
  maxHops?: number;
  cacheTtlMs?: number;
  /** Test seam: clock override. */
  now?: () => number;
}

interface WalkOutcome {
  rootOwnerGlobalMetaId: string;
  chain: TrustChainLink[];
  /** Per-subject observations for the cache: subject gmid -> seen pinId (null = none). */
  observedPins: Array<{ subjectGmid: string; pin: LatestOwnerPin | null }>;
}

async function walkOwnerChain(
  startGmid: string,
  maxHops: number,
  pinReader: OwnerPinReader,
): Promise<WalkOutcome> {
  const chain: TrustChainLink[] = [];
  const observedPins: WalkOutcome['observedPins'] = [];
  let subject = startGmid;

  for (let hop = 0; hop < maxHops; hop += 1) {
    let pin: LatestOwnerPin | null = null;
    try {
      pin = await pinReader(subject);
    } catch {
      // A read failure is not proof of absence, but the conservative
      // direction for trust is to stop the walk at the last verified link.
      pin = null;
    }
    observedPins.push({ subjectGmid: subject, pin });
    if (!pin || !pin.payload) break;

    const payload = parseOwnerBindingPayload(pin.payload);
    if (!payload) break; // empty / malformed payload = unbound
    if (!verifyOwnerBinding(pin.payload, subject)) break; // unverifiable link terminates the walk

    chain.push({ subjectGmid: subject, ownerGmid: payload.owner, pinId: pin.pinId });
    subject = payload.owner;
  }

  return {
    rootOwnerGlobalMetaId: chain.length > 0 ? chain[chain.length - 1].ownerGmid : startGmid,
    chain,
    observedPins,
  };
}

export function createRootOwnerResolver(input: CreateRootOwnerResolverInput = {}): RootOwnerResolver {
  const maxHops = Math.max(1, Math.floor(input.maxHops ?? DEFAULT_MAX_HOPS));
  const cacheTtlMs = input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = input.now ?? (() => Date.now());
  const pinReader = input.pinReader ?? createOwnerPinReader();
  const cache: TrustCacheStore = input.cache
    ?? (input.systemHomeDir ? createTrustCacheStore(input.systemHomeDir) : createMemoryTrustCacheStore());

  async function resolve(globalMetaId: string, requestedHops: number, forceRefresh: boolean) {
    const normalized = normalizeGlobalMetaId(globalMetaId);
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
      const entry: TrustCacheEntry = {
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
      const normalized = normalizeGlobalMetaId(globalMetaId);
      if (!normalized) return;
      await cache.invalidate(normalized);
    },
  };
}

/** Fallback when neither systemHomeDir nor a cache is provided (library/test use). */
function createMemoryTrustCacheStore(): TrustCacheStore {
  const entries = new Map<string, TrustCacheEntry>();
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
    async clear() {
      entries.clear();
    },
  };
}
