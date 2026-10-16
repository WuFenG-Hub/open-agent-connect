import { commandFailed, commandSuccess, type MetabotCommandResult } from '../../core/contracts/commandResult';
import { normalizeGlobalMetaId } from '../../core/identity/deriveIdentity';
import {
  blockGmid,
  createTrustLocalStore,
  unblockGmid,
} from '../../core/trust/trustLocalStore';
import { normalizeSystemHomeDir } from '../../core/state/homeSelection';
import { commandUnknownSubcommand, redactSensitiveArgs } from './helpers';
import type { CliRuntimeContext } from '../types';

/**
 * The device-level blocklist (trust tiers P2, M1): pure local state at
 * `~/.metabot/owner/trust-local.json` — no daemon required. add/remove also
 * drop the peer's cached trust resolution (blockGmid/unblockGmid), so the
 * next tier check re-resolves. On-chain `simpleblock` replaces/merges this
 * in M2.
 */
export async function runBlockCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const subcommand = args[0];
  const systemHomeDir = normalizeSystemHomeDir(context.env, context.cwd);
  const store = createTrustLocalStore(systemHomeDir);

  if (subcommand === 'list') {
    return commandSuccess(await store.read());
  }

  if (subcommand === 'add' || subcommand === 'remove') {
    const globalMetaId = normalizeGlobalMetaId(args[1] ?? '');
    if (!globalMetaId) {
      return commandFailed('invalid_global_meta_id', `Usage: metabot block ${subcommand} <globalMetaId>`);
    }
    const state = subcommand === 'add'
      ? await blockGmid(systemHomeDir, globalMetaId)
      : await unblockGmid(systemHomeDir, globalMetaId);
    return commandSuccess({
      blocked: state.blocked,
      [subcommand === 'add' ? 'added' : 'removed']: globalMetaId,
    });
  }

  return commandUnknownSubcommand(`block ${redactSensitiveArgs(args).join(' ')}`.trim());
}
