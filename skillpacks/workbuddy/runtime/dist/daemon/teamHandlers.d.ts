/**
 * Daemon-side team handler group: the /api/team/* verbs backing the
 * `metabot team *` CLI surface (trust tiers P5). The team registry lists
 * REMOTE Bots bound to the same root owner — candidates for cross-device
 * group-task seating. `add` verifies the peer's root owner == my root owner
 * on-chain before recording; `list` combines local profiles with registry
 * entries (manual + auto-recorded).
 */
import type { RootOwnerResolver } from '../core/trust/rootOwnerResolver';
import type { MetabotDaemonHttpHandlers } from './routes/types';
export interface TeamDaemonHandlersInput {
    /** The machine-wide system home that owns `~/.metabot/owner/`. */
    systemHomeDir: string;
    /**
     * Root-owner resolver for the `add` verification (walks /info/owner chains).
     * Absent = `team add` fails with team_verification_unavailable (fail closed).
     */
    rootOwnerResolver?: RootOwnerResolver;
}
export declare function createTeamDaemonHandlers(input: TeamDaemonHandlersInput): NonNullable<MetabotDaemonHttpHandlers['team']>;
