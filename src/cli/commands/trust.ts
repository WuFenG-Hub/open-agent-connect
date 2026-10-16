import { commandFailed, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { normalizeGlobalMetaId } from '../../core/identity/deriveIdentity';
import { commandUnknownSubcommand, readFlagValue, redactSensitiveArgs } from './helpers';
import type { CliRuntimeContext } from '../types';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The on-chain owner trust grants (trust tiers P2): the local root owner
 * publishes append-only /protocols/simpletrust pins. grant/revoke publish
 * (daemon-side, they need the owner signer); list resolves the effective
 * set (grants minus revokes) from chain through the daemon.
 */
export async function runTrustCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const subcommand = args[0];

  if (subcommand === 'list') {
    const handler = context.dependencies.trust?.list;
    if (!handler) {
      return commandFailed('not_implemented', 'Trust list handler is not configured. Is the daemon running a build that supports it?');
    }
    return handler();
  }

  if (subcommand === 'grant') {
    const trustedOwner = normalizeGlobalMetaId(args[1] ?? '');
    if (!trustedOwner) {
      return commandFailed('invalid_trusted_owner', 'Usage: metabot trust grant <ownerGlobalMetaId> [--note <text>]');
    }
    const note = readFlagValue(args, '--note') ?? undefined;
    const handler = context.dependencies.trust?.grant;
    if (!handler) {
      return commandFailed('not_implemented', 'Trust grant handler is not configured. Is the daemon running a build that supports it?');
    }
    return handler({ trustedOwner, note });
  }

  if (subcommand === 'revoke') {
    const target = normalizeText(args[1]);
    if (!target) {
      return commandFailed('missing_revoke_target', 'Usage: metabot trust revoke <ownerGlobalMetaId | grantPinId>');
    }
    const handler = context.dependencies.trust?.revoke;
    if (!handler) {
      return commandFailed('not_implemented', 'Trust revoke handler is not configured. Is the daemon running a build that supports it?');
    }
    return handler({ target });
  }

  return commandUnknownSubcommand(`trust ${redactSensitiveArgs(args).join(' ')}`.trim());
}
