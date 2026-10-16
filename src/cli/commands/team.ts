import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { normalizeGlobalMetaId } from '../../core/identity/deriveIdentity';
import { commandUnknownSubcommand, redactSensitiveArgs } from './helpers';
import type { CliRuntimeContext } from '../types';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The remote team Bot registry (trust tiers P5): Bots on OTHER devices bound
 * to the same root owner — candidates for cross-device group-task seating
 * and staffing slates. `add` verifies the shared root owner on-chain before
 * recording (clear team_not_same_owner error otherwise); entries are also
 * auto-recorded when a peer resolves to the team tier. Purely local reads +
 * the verified add go through the daemon (root-owner resolution needs the
 * chain resolvers).
 */
export async function runTeamCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const subcommand = args[0];

  if (subcommand === 'list') {
    const handler = context.dependencies.team?.list;
    if (!handler) {
      return commandFailed('not_implemented', 'Team list handler is not configured. Is the daemon running a build that supports it?');
    }
    return handler({});
  }

  if (subcommand === 'add' || subcommand === 'remove') {
    const globalMetaId = normalizeGlobalMetaId(args[1] ?? '');
    if (!globalMetaId) {
      return commandFailed('invalid_global_meta_id', `Usage: metabot team ${subcommand} <globalMetaId>`);
    }
    const handler = context.dependencies.team?.[subcommand];
    if (!handler) {
      return commandFailed('not_implemented', `Team ${subcommand} handler is not configured. Is the daemon running a build that supports it?`);
    }
    return handler({ globalMetaId });
  }

  return commandUnknownSubcommand(`team ${redactSensitiveArgs(args).join(' ')}`.trim());
}
