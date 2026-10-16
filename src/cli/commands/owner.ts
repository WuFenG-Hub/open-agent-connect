import { commandFailed, commandSuccess, type MetabotCommandResult } from '../../core/contracts/commandResult';
import {
  createRootOwnerIdentity,
  importRootOwnerIdentity,
  loadRootOwnerIdentity,
  renameRootOwnerIdentity,
  resolveRootOwnerIdentityPath,
  revealRootOwnerMnemonic,
  RootOwnerIdentityError,
  rootOwnerExists,
  toRootOwnerIdentityPublic,
} from '../../core/owner/rootOwnerIdentity';
import { normalizeSystemHomeDir } from '../../core/state/homeSelection';
import { commandMissingFlag, commandUnknownSubcommand, hasFlag, readFlagValue, readJsonFile, readStdinText, redactSensitiveArgs } from './helpers';
import type { CliRuntimeContext } from '../types';

function rootOwnerFailure(error: unknown): MetabotCommandResult<never> {
  if (error instanceof RootOwnerIdentityError) {
    return commandFailed(error.code, error.message);
  }
  return commandFailed('root_owner_failed', error instanceof Error ? error.message : String(error));
}

/**
 * The root Owner Identity commands (trust tiers P1): the human's portable,
 * machine-wide identity one layer above the Device Identity (`metabot user *`).
 * CRUD is local; `bind-device` publishes the on-chain device→owner binding
 * and therefore runs daemon-side (it needs the chain signer + sponsor hook).
 */
export async function runOwnerCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>> {
  const subcommand = args[0];
  const systemHomeDir = normalizeSystemHomeDir(context.env, context.cwd);

  if (subcommand === 'who') {
    const record = await loadRootOwnerIdentity(systemHomeDir);
    return commandSuccess({ identity: record ? toRootOwnerIdentityPublic(record) : null });
  }

  if (subcommand === 'exists') {
    return commandSuccess({ exists: await rootOwnerExists(systemHomeDir) });
  }

  if (subcommand === 'path') {
    return commandSuccess({ path: resolveRootOwnerIdentityPath(systemHomeDir) });
  }

  if (subcommand === 'create') {
    const name = readFlagValue(args, '--name') ?? '';
    try {
      const record = await createRootOwnerIdentity(systemHomeDir, { name });
      // The mnemonic is shown exactly once, same as the device identity create.
      return commandSuccess({ identity: toRootOwnerIdentityPublic(record), mnemonic: record.mnemonic });
    } catch (error) {
      return rootOwnerFailure(error);
    }
  }

  if (subcommand === 'import') {
    // The mnemonic is a master secret. argv values land in shell history and
    // process listings, so the stdin and request-file channels are the
    // recommended paths; exactly one channel may be provided.
    const nameFlag = readFlagValue(args, '--name');
    const pathFlag = readFlagValue(args, '--path');
    const mnemonicFlag = readFlagValue(args, '--mnemonic');
    const mnemonicFromStdin = hasFlag(args, '--mnemonic-stdin');
    const requestFile = readFlagValue(args, '--request-file');
    const channelCount = [mnemonicFlag !== null, mnemonicFromStdin, requestFile !== null].filter(Boolean).length;
    if (channelCount > 1) {
      return commandFailed('conflicting_flags', 'Provide exactly one mnemonic channel: --mnemonic-stdin, --request-file, or --mnemonic.');
    }
    if (channelCount === 0) {
      return commandFailed('missing_mnemonic', 'Missing mnemonic. Use --mnemonic-stdin (recommended) or --request-file <json>; --mnemonic <words> also works but lands in shell history.');
    }
    let payload: Record<string, unknown> = {};
    if (requestFile) {
      try {
        payload = await readJsonFile(context, requestFile);
      } catch (error) {
        return commandFailed('invalid_request_file', error instanceof Error ? error.message : String(error));
      }
    }
    let mnemonic: string;
    if (mnemonicFlag !== null) {
      if (!mnemonicFlag.trim()) {
        return commandFailed('missing_mnemonic', 'The --mnemonic value is empty.');
      }
      mnemonic = mnemonicFlag;
    } else if (mnemonicFromStdin) {
      mnemonic = (await readStdinText(context.stdin)).trim();
      if (!mnemonic) {
        return commandFailed('missing_mnemonic', 'No mnemonic received on stdin. Pipe or type the BIP39 words and end with EOF (Ctrl-D).');
      }
    } else {
      mnemonic = typeof payload.mnemonic === 'string' ? payload.mnemonic.trim() : '';
      if (!mnemonic) {
        return commandFailed('invalid_request_file', 'Request file must include a non-empty "mnemonic".');
      }
    }
    const name = nameFlag ?? (typeof payload.name === 'string' ? payload.name : '');
    const derivationPath = pathFlag
      ?? (typeof payload.path === 'string' && payload.path.trim() ? payload.path.trim() : undefined);
    try {
      const record = await importRootOwnerIdentity(systemHomeDir, { name, mnemonic, path: derivationPath });
      return commandSuccess({ identity: toRootOwnerIdentityPublic(record), mnemonic: record.mnemonic });
    } catch (error) {
      return rootOwnerFailure(error);
    }
  }

  if (subcommand === 'rename') {
    const name = readFlagValue(args, '--name');
    if (!name) {
      return commandMissingFlag('--name');
    }
    try {
      const record = await renameRootOwnerIdentity(systemHomeDir, name);
      return commandSuccess({ identity: toRootOwnerIdentityPublic(record) });
    } catch (error) {
      return rootOwnerFailure(error);
    }
  }

  if (subcommand === 'reveal') {
    try {
      const mnemonic = await revealRootOwnerMnemonic(systemHomeDir);
      return commandSuccess({ mnemonic });
    } catch (error) {
      return rootOwnerFailure(error);
    }
  }

  if (subcommand === 'bind-device') {
    // Sign (root owner key) + publish (device identity) the /info/owner
    // device→owner binding pin. The publish happens daemon-side (signer +
    // traffic sponsor hook live there); the CLI only forwards.
    const handler = context.dependencies.owner?.bindDevice;
    if (!handler) {
      return commandFailed('not_implemented', 'Owner bind-device handler is not configured. Is the daemon running a build that supports it?');
    }
    return handler();
  }

  return commandUnknownSubcommand(`owner ${redactSensitiveArgs(args).join(' ')}`.trim());
}
