export interface ChatViewerUserInfo {
    globalMetaId?: string;
    metaid?: string;
    metaId?: string;
    name?: string;
    nickname?: string;
    avatar?: string;
    avatarUri?: string;
}
export interface ChatViewerMessage {
    id: string;
    pinId?: string;
    txId?: string;
    protocol: string;
    type?: '2';
    content: string;
    contentType?: string;
    timestamp: number;
    index: number;
    fromGlobalMetaId: string;
    toGlobalMetaId: string;
    fromUserInfo?: ChatViewerUserInfo | null;
    toUserInfo?: ChatViewerUserInfo | null;
    userInfo?: ChatViewerUserInfo | null;
    replyPin?: string;
    replyInfo?: ChatReplyInfo | null;
    mention?: Array<unknown>;
    chain?: string;
}
/**
 * Resolved context for a quoted message (the message this one replies to).
 * `content` is resolved from the same conversation's already-fetched message
 * set, so quoting never costs an extra network round trip. A quote whose
 * target is not in the current window is reported with `unresolved: true`
 * and an empty `content` rather than being silently dropped — the UI can
 * then show "quoted message not loaded" instead of rendering nothing.
 */
export interface ChatReplyInfo {
    /** pinId of the quoted message (the value carried on the wire). */
    pinId: string;
    /** Quoted body, already truncated to QUOTE_CONTENT_MAX_LENGTH when needed. */
    content: string;
    /** True when the quoted body was cut at QUOTE_CONTENT_MAX_LENGTH. */
    truncated: boolean;
    /** True when the quoted message is not present in the fetched window. */
    unresolved: boolean;
    senderLabel: string;
    timestamp: number;
}
/**
 * Quoted bodies render inline in a bubble, so a multi-thousand-character quote
 * would blow up the thread layout and the transcript export. The cut is
 * explicit (`truncated: true` + an ellipsis) rather than silent.
 */
export declare const QUOTE_CONTENT_MAX_LENGTH = 1000;
export declare function isValidQuotePinId(value: unknown): boolean;
/**
 * Build the reply context for one message from the conversation's own rows.
 * Returns null when the message carries no quote.
 */
export declare function buildReplyInfo(input: {
    replyPin: string;
    byPinId: Map<string, ChatViewerMessage>;
}): ChatReplyInfo | null;
/** Index messages by every id a quote may reference; first occurrence wins. */
export declare function indexMessagesByPinId(messages: ChatViewerMessage[]): Map<string, ChatViewerMessage>;
export interface FetchPrivateHistoryInput {
    selfGlobalMetaId: string;
    peerGlobalMetaId: string;
    afterIndex?: number;
    limit: number;
}
export interface FetchPrivateHistoryPageInput {
    selfGlobalMetaId: string;
    peerGlobalMetaId: string;
    startIndex?: number;
    limit: number;
    timeoutMs?: number;
}
export interface PrivateChatHistoryPage {
    rows: unknown[];
    total: number | null;
    nextTimestamp: number | null;
}
export interface FetchPrivateChatPeerGlobalMetaIdsInput {
    selfGlobalMetaId: string;
    knownPeers?: Array<{
        globalMetaId: string;
        chatPublicKey?: string | null;
    }>;
    fetchImpl?: typeof fetch;
    chatApiBaseUrl?: string;
    timeoutMs?: number;
}
export type FetchPrivateHistory = (input: FetchPrivateHistoryInput) => Promise<unknown[]>;
export interface PrivateConversationResponse {
    ok: true;
    selfGlobalMetaId: string;
    peerGlobalMetaId: string;
    messages: ChatViewerMessage[];
    nextPollAfterIndex: number;
    serverTime: number;
}
export declare function normalizeConversationLimit(value: unknown): number;
export declare function normalizeConversationAfterIndex(value: unknown): number | undefined;
export declare function extractPrivateChatPeerGlobalMetaIds(rawData: unknown, selfGlobalMetaId: string, knownPeers?: FetchPrivateChatPeerGlobalMetaIdsInput['knownPeers']): string[];
export declare function fetchPrivateChatPeerGlobalMetaIds(input: FetchPrivateChatPeerGlobalMetaIdsInput): Promise<string[]>;
export declare function fetchPrivateChatHistoryPage(input: FetchPrivateHistoryPageInput & {
    fetchImpl?: typeof fetch;
    chatApiBaseUrl?: string;
}): Promise<PrivateChatHistoryPage>;
export declare function fetchPrivateChatHistory(input: FetchPrivateHistoryInput & {
    fetchImpl?: typeof fetch;
    chatApiBaseUrl?: string;
}): Promise<unknown[]>;
