import { type AuthorPathPin, type OwnerPathPinLister } from './ownerPinRead';
import { type ResolvedTrustGrant, type TrustCacheStore } from './trustCacheStore';
export interface TrustedOwnersResolution {
    trustedOwners: ResolvedTrustGrant[];
    /** True when served from the trust cache without any chain read. */
    fromCache: boolean;
}
export interface TrustedOwnerResolver {
    resolveTrustedOwners(ownerGlobalMetaId: string, options?: {
        forceRefresh?: boolean;
    }): Promise<TrustedOwnersResolution>;
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
export declare function computeEffectiveTrustGrants(pins: AuthorPathPin[]): ResolvedTrustGrant[];
export declare function createTrustedOwnerResolver(input?: CreateTrustedOwnerResolverInput): TrustedOwnerResolver;
