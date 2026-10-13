import type { Writable } from 'node:stream';

/**
 * Serialized write queue for the ACP child's stdin. Writes are one JSON-RPC
 * line each, handed to the stream strictly in order with a total byte budget;
 * once the stream fails (EPIPE, destroyed) or the budget is exceeded, every
 * queued and future write settles against the same terminal error instead of
 * surfacing an unhandled stream error.
 */
export const ACP_MAX_QUEUED_WRITE_BYTES = 32 * 1024 * 1024;

interface QueuedWrite {
  line: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class AcpWriteQueue {
  private readonly queue: QueuedWrite[] = [];
  private bytes = 0;
  private active?: QueuedWrite;
  private terminalError?: Error;

  constructor(
    private readonly output: Writable,
    private readonly maxBytes: number = ACP_MAX_QUEUED_WRITE_BYTES,
  ) {}

  write(line: string): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.bytes + bytes > this.maxBytes) {
      return Promise.reject(new Error(`ACP write queue exceeded ${this.maxBytes} bytes`));
    }
    this.bytes += bytes;
    return new Promise((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      this.flush();
    });
  }

  close(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.active?.reject(error);
    this.active = undefined;
    for (const queued of this.queue.splice(0)) {
      queued.reject(error);
    }
    this.bytes = 0;
  }

  private flush(): void {
    if (this.active || this.terminalError) return;
    const write = this.queue.shift();
    if (!write) return;
    this.active = write;
    if (this.output.destroyed || !this.output.writable) {
      this.onWriteFailed(new Error('ACP agent stdin is no longer writable'));
      return;
    }
    let settled = false;
    const complete = (): void => {
      if (settled || this.terminalError) return;
      settled = true;
      this.active = undefined;
      this.bytes -= Buffer.byteLength(write.line, 'utf8');
      write.resolve();
      this.flush();
    };
    try {
      this.output.write(write.line, (error) => {
        if (error) {
          this.onWriteFailed(error);
          return;
        }
        complete();
      });
    } catch (error) {
      this.onWriteFailed(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onWriteFailed(error: Error): void {
    this.close(error);
  }
}
