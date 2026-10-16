import { type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';
/**
 * The remote team Bot registry (trust tiers P5): Bots on OTHER devices bound
 * to the same root owner — candidates for cross-device group-task seating
 * and staffing slates. `add` verifies the shared root owner on-chain before
 * recording (clear team_not_same_owner error otherwise); entries are also
 * auto-recorded when a peer resolves to the team tier. Purely local reads +
 * the verified add go through the daemon (root-owner resolution needs the
 * chain resolvers).
 */
export declare function runTeamCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>>;
