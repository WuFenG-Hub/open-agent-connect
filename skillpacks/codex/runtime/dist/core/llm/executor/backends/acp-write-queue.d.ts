import type { Writable } from 'node:stream';
/**
 * Serialized write queue for the ACP child's stdin. Writes are one JSON-RPC
 * line each, handed to the stream strictly in order with a total byte budget;
 * once the stream fails (EPIPE, destroyed) or the budget is exceeded, every
 * queued and future write settles against the same terminal error instead of
 * surfacing an unhandled stream error.
 */
export declare const ACP_MAX_QUEUED_WRITE_BYTES: number;
export declare class AcpWriteQueue {
    private readonly output;
    private readonly maxBytes;
    private readonly queue;
    private bytes;
    private active?;
    private terminalError?;
    constructor(output: Writable, maxBytes?: number);
    write(line: string): Promise<void>;
    close(error: Error): void;
    private flush;
    private onWriteFailed;
}
