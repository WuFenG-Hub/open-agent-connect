export interface TrustChainLink {
    /** The identity that published the /info/owner pin. */
    subjectGmid: string;
    /** The identity the payload binds as directly accountable for the subject. */
    ownerGmid: string;
    /** The pinId whose payload was verified. */
    pinId: string;
}
export interface TrustCacheEntry {
    subjectGlobalMetaId: string;
    /** Latest /info/owner pinId this resolution is based on; null = subject had no binding pin. */
    pinId: string | null;
    /** Terminal verified gmid of the walk (the root owner; may equal the subject). */
    rootOwnerGlobalMetaId: string;
    /** Verified links starting at this subject. */
    chain: TrustChainLink[];
    /** ISO timestamp of the resolution. */
    resolvedAt: string;
}
/** One effective trust grant after the grants-minus-revokes fold. */
export interface ResolvedTrustGrant {
    trustedOwner: string;
    note?: string;
    /** Unix seconds from the grant payload. */
    ts: number;
    /** The grant pinId (what a revoke pin references). */
    grantPinId: string;
}
export interface TrustGrantCacheEntry {
    ownerGlobalMetaId: string;
    /** Newest simpletrust pinId this resolution is based on; null = owner has no pins. */
    pinId: string | null;
    trustedOwners: ResolvedTrustGrant[];
    /** ISO timestamp of the resolution. */
    resolvedAt: string;
}
export interface TrustCacheStore {
    get(subjectGlobalMetaId: string): Promise<TrustCacheEntry | null>;
    set(entry: TrustCacheEntry): Promise<void>;
    /** Drop one subject (e.g. right after its binding pin was re-published). */
    invalidate(subjectGlobalMetaId: string): Promise<void>;
    getGrants(ownerGlobalMetaId: string): Promise<TrustGrantCacheEntry | null>;
    setGrants(entry: TrustGrantCacheEntry): Promise<void>;
    /** Drop one owner's grant resolution (right after publishing a grant/revoke). */
    invalidateGrants(ownerGlobalMetaId: string): Promise<void>;
    clear(): Promise<void>;
}
export declare function createTrustCacheStore(systemHomeDir: string): TrustCacheStore;
