/**
 * Classifies a truncated JSON-RPC record from its leading bytes, so an
 * oversized ACP line can be handled without parsing (or buffering) the whole
 * frame: a server request gets a protocol error reply, a response bound to a
 * known pending call settles exactly that call, and an unbindable response
 * aborts the peer instead of leaving a pending call hanging.
 */
export type AcpRecordPrefix = {
    kind: 'response';
    id: number;
} | {
    kind: 'agent-request';
    id: number | string;
    method: string;
} | {
    kind: 'notification';
    method: string;
} | {
    kind: 'response-unknown';
} | {
    kind: 'unknown';
};
export declare function classifyAcpRecordPrefix(prefix: string): AcpRecordPrefix;
