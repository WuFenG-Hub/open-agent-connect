export declare const DEFAULT_OWNER_PIN_MANAPI_BASE_URL = "https://manapi.metaid.io";
export interface LatestOwnerPin {
    pinId: string;
    /** Full pin payload string; null when the pin body is empty (unbound). */
    payload: string | null;
}
/** Injectable read seam: latest /info/owner pin for a subject GlobalMetaID, or null. */
export type OwnerPinReader = (globalMetaId: string) => Promise<LatestOwnerPin | null>;
export interface OwnerPinReadOptions {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}
/** Step 1: the subject's on-chain info record; the address drives the per-author pin list. */
export declare function resolveMetaIdOwnerAddress(globalMetaId: string, options?: OwnerPinReadOptions): Promise<string | null>;
export interface AuthorPinListRow {
    pinId: string;
    operation: string;
    timestamp: number;
    path: string;
    globalMetaId: string;
}
/**
 * Step 2: the effective (latest, non-revoked) pin row the subject published
 * at `path`, newest first. Revoked rows mean "unbound" and are skipped;
 * malformed envelopes yield null instead of throwing (a read failure makes
 * the caller treat the subject as unbound — the conservative direction).
 */
export declare function listLatestAuthorPin(address: string, path: string, options?: OwnerPinReadOptions): Promise<AuthorPinListRow | null>;
/** Step 3: the full pin body; an empty body means unbound (payload null). */
export declare function fetchOwnerPinContent(pinId: string, options?: OwnerPinReadOptions): Promise<string | null>;
/**
 * Default OwnerPinReader: address -> latest /info/owner row -> full payload.
 * Any failed/empty step yields null (treated as "no verifiable binding").
 */
export declare function createOwnerPinReader(options?: OwnerPinReadOptions): OwnerPinReader;
export interface AuthorPathPin {
    pinId: string;
    operation: string;
    /** Unix seconds; 0 when unknown. */
    timestamp: number;
    /** Full pin body; null when empty/unreadable (callers treat as absent). */
    payload: string | null;
}
/** Injectable seam: every pin `globalMetaId` published at `path`, newest first. */
export type OwnerPathPinLister = (globalMetaId: string, path: string) => Promise<AuthorPathPin[]>;
export interface OwnerPathPinListOptions extends OwnerPinReadOptions {
    pageSize?: number;
    maxPages?: number;
}
/**
 * All pins an author published at `path` (grants and revoke payloads alike;
 * operation-level revoked rows carry no payload and are skipped), each with
 * its full body fetched by pinId. Read failures degrade to fewer pins —
 * resolution treats a failed read as "nothing more to fold", same as an
 * absent author.
 */
export declare function listAuthorPathPins(globalMetaId: string, path: string, options?: OwnerPathPinListOptions): Promise<AuthorPathPin[]>;
/** Default OwnerPathPinLister delegating to listAuthorPathPins. */
export declare function createOwnerPathPinLister(options?: OwnerPathPinListOptions): OwnerPathPinLister;
