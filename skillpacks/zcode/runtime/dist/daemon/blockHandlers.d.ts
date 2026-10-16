/**
 * Daemon-side blocklist handler group: the /api/block/* verbs (trust tiers
 * P2). Purely local — backed by `~/.metabot/owner/trust-local.json` via the
 * core trustLocalStore; add/remove also drop the peer's cached trust
 * resolution (blockGmid/unblockGmid composition), so the next tier check
 * never serves stale state for the changed peer.
 */
import type { MetabotDaemonHttpHandlers } from './routes/types';
export interface BlockDaemonHandlersInput {
    /** The machine-wide system home that owns `~/.metabot/owner/`. */
    systemHomeDir: string;
    /** Called after a successful add/remove so consumers (e.g. the P3 peer
     *  tier resolver's short-TTL cache) can drop stale tier entries. */
    onTrustConfigChanged?: () => void;
}
export declare function createBlockDaemonHandlers(input: BlockDaemonHandlersInput): NonNullable<MetabotDaemonHttpHandlers['block']>;
