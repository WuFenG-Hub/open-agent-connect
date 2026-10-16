import { type OwnerPinReader } from './ownerPinRead';
import { type TrustCacheStore, type TrustChainLink } from './trustCacheStore';
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
    resolveRootOwner(globalMetaId: string, options?: {
        forceRefresh?: boolean;
    }): Promise<RootOwnerResolution>;
    /** One hop up (Bot -> its directly accountable identity, usually the Device). */
    resolveDeviceOwner(globalMetaId: string, options?: {
        forceRefresh?: boolean;
    }): Promise<DeviceOwnerResolution>;
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
export declare function createRootOwnerResolver(input?: CreateRootOwnerResolverInput): RootOwnerResolver;
