export interface TrustLocalState {
    blocked: string[];
    contacts: string[];
}
export interface TrustLocalStore {
    read(): Promise<TrustLocalState>;
    setBlocked(globalMetaId: string, blocked: boolean): Promise<TrustLocalState>;
    setContact(globalMetaId: string, contact: boolean): Promise<TrustLocalState>;
}
export declare function normalizeTrustLocalState(value: unknown): TrustLocalState;
export declare function createTrustLocalStore(systemHomeDir: string): TrustLocalStore;
/**
 * Block a peer device-wide AND drop its cached trust resolution, so the next
 * tier check re-resolves instead of serving stale state. Unblocking likewise
 * clears the cache entry.
 */
export declare function blockGmid(systemHomeDir: string, globalMetaId: string): Promise<TrustLocalState>;
export declare function unblockGmid(systemHomeDir: string, globalMetaId: string): Promise<TrustLocalState>;
export declare function listBlockedGmids(systemHomeDir: string): Promise<string[]>;
export declare function isBlockedGmid(systemHomeDir: string, globalMetaId: string): Promise<boolean>;
