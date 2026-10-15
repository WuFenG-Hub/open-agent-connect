import { type MetabotDaemonPaths, type MetabotPaths } from '../core/state/paths';
import type { MetabotDaemonHttpHandlers } from './routes/types';
/** How long quarantined `daemon.lock.stale-*` files are kept for forensics. */
export declare const DAEMON_STALE_LOCK_RETENTION_MS: number;
/** Stable error code for losing the daemon lock race (concurrent auto-starts). */
export declare const DAEMON_LOCK_TIMEOUT_CODE = "daemon_lock_timeout";
export interface MetabotDaemonAddress {
    host: string;
    port: number;
    baseUrl: string;
}
export interface MetabotDaemonInstance {
    ownerId: string;
    lockPath: string;
    start(port?: number, host?: string): Promise<MetabotDaemonAddress>;
    close(): Promise<void>;
}
export interface CreateMetabotDaemonOptions {
    homeDirOrPaths: string | MetabotPaths;
    daemonPaths?: MetabotDaemonPaths;
    handlers?: MetabotDaemonHttpHandlers;
    ownerId?: string;
}
export declare function createMetabotDaemon(options: CreateMetabotDaemonOptions): MetabotDaemonInstance;
