/**
 * Bounded NDJSON framing for the ACP stdio peer, with the semantics a
 * turn-based client needs: lines above `maxLineBytes` are rejected (not
 * buffered into memory), a bounded prefix of each rejected line is retained
 * for classification, and invalid JSON lines are surfaced instead of thrown
 * away. Modeled after the framing layer long-lived ACP orchestrators use,
 * minus their pause/resume queueing (this framer is consumed eagerly).
 */
export declare const ACP_NDJSON_MAX_LINE_BYTES: number;
export declare const ACP_REJECTED_LINE_PREFIX_MAX_BYTES: number;
export type AcpRejectedRecord = {
    kind: 'line-too-long';
    maxLineBytes: number;
    observedBytes: number;
    prefix: string;
} | {
    kind: 'invalid-json';
    line: string;
    error: Error;
};
export interface BoundedNdjsonFramer {
    feed(chunk: string): void;
    reset(): void;
}
export declare function createBoundedNdjsonFramer(onRecord: (record: unknown, line: string) => void, onRejected: (rejected: AcpRejectedRecord) => void, options?: {
    maxLineBytes?: number;
}): BoundedNdjsonFramer;
