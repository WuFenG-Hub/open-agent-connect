"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOwnerCommand = runOwnerCommand;
const commandResult_1 = require("../../core/contracts/commandResult");
const rootOwnerIdentity_1 = require("../../core/owner/rootOwnerIdentity");
const homeSelection_1 = require("../../core/state/homeSelection");
const helpers_1 = require("./helpers");
function rootOwnerFailure(error) {
    if (error instanceof rootOwnerIdentity_1.RootOwnerIdentityError) {
        return (0, commandResult_1.commandFailed)(error.code, error.message);
    }
    return (0, commandResult_1.commandFailed)('root_owner_failed', error instanceof Error ? error.message : String(error));
}
/**
 * The root Owner Identity commands (trust tiers P1): the human's portable,
 * machine-wide identity one layer above the Device Identity (`metabot user *`).
 * CRUD is local; `bind-device` publishes the on-chain device→owner binding
 * and therefore runs daemon-side (it needs the chain signer + sponsor hook).
 */
async function runOwnerCommand(args, context) {
    const subcommand = args[0];
    const systemHomeDir = (0, homeSelection_1.normalizeSystemHomeDir)(context.env, context.cwd);
    if (subcommand === 'who') {
        const record = await (0, rootOwnerIdentity_1.loadRootOwnerIdentity)(systemHomeDir);
        return (0, commandResult_1.commandSuccess)({ identity: record ? (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record) : null });
    }
    if (subcommand === 'exists') {
        return (0, commandResult_1.commandSuccess)({ exists: await (0, rootOwnerIdentity_1.rootOwnerExists)(systemHomeDir) });
    }
    if (subcommand === 'path') {
        return (0, commandResult_1.commandSuccess)({ path: (0, rootOwnerIdentity_1.resolveRootOwnerIdentityPath)(systemHomeDir) });
    }
    if (subcommand === 'create') {
        const name = (0, helpers_1.readFlagValue)(args, '--name') ?? '';
        try {
            const record = await (0, rootOwnerIdentity_1.createRootOwnerIdentity)(systemHomeDir, { name });
            // The mnemonic is shown exactly once, same as the device identity create.
            return (0, commandResult_1.commandSuccess)({ identity: (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record), mnemonic: record.mnemonic });
        }
        catch (error) {
            return rootOwnerFailure(error);
        }
    }
    if (subcommand === 'import') {
        // The mnemonic is a master secret. argv values land in shell history and
        // process listings, so the stdin and request-file channels are the
        // recommended paths; exactly one channel may be provided.
        const nameFlag = (0, helpers_1.readFlagValue)(args, '--name');
        const pathFlag = (0, helpers_1.readFlagValue)(args, '--path');
        const mnemonicFlag = (0, helpers_1.readFlagValue)(args, '--mnemonic');
        const mnemonicFromStdin = (0, helpers_1.hasFlag)(args, '--mnemonic-stdin');
        const requestFile = (0, helpers_1.readFlagValue)(args, '--request-file');
        const channelCount = [mnemonicFlag !== null, mnemonicFromStdin, requestFile !== null].filter(Boolean).length;
        if (channelCount > 1) {
            return (0, commandResult_1.commandFailed)('conflicting_flags', 'Provide exactly one mnemonic channel: --mnemonic-stdin, --request-file, or --mnemonic.');
        }
        if (channelCount === 0) {
            return (0, commandResult_1.commandFailed)('missing_mnemonic', 'Missing mnemonic. Use --mnemonic-stdin (recommended) or --request-file <json>; --mnemonic <words> also works but lands in shell history.');
        }
        let payload = {};
        if (requestFile) {
            try {
                payload = await (0, helpers_1.readJsonFile)(context, requestFile);
            }
            catch (error) {
                return (0, commandResult_1.commandFailed)('invalid_request_file', error instanceof Error ? error.message : String(error));
            }
        }
        let mnemonic;
        if (mnemonicFlag !== null) {
            if (!mnemonicFlag.trim()) {
                return (0, commandResult_1.commandFailed)('missing_mnemonic', 'The --mnemonic value is empty.');
            }
            mnemonic = mnemonicFlag;
        }
        else if (mnemonicFromStdin) {
            mnemonic = (await (0, helpers_1.readStdinText)(context.stdin)).trim();
            if (!mnemonic) {
                return (0, commandResult_1.commandFailed)('missing_mnemonic', 'No mnemonic received on stdin. Pipe or type the BIP39 words and end with EOF (Ctrl-D).');
            }
        }
        else {
            mnemonic = typeof payload.mnemonic === 'string' ? payload.mnemonic.trim() : '';
            if (!mnemonic) {
                return (0, commandResult_1.commandFailed)('invalid_request_file', 'Request file must include a non-empty "mnemonic".');
            }
        }
        const name = nameFlag ?? (typeof payload.name === 'string' ? payload.name : '');
        const derivationPath = pathFlag
            ?? (typeof payload.path === 'string' && payload.path.trim() ? payload.path.trim() : undefined);
        try {
            const record = await (0, rootOwnerIdentity_1.importRootOwnerIdentity)(systemHomeDir, { name, mnemonic, path: derivationPath });
            return (0, commandResult_1.commandSuccess)({ identity: (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record), mnemonic: record.mnemonic });
        }
        catch (error) {
            return rootOwnerFailure(error);
        }
    }
    if (subcommand === 'rename') {
        const name = (0, helpers_1.readFlagValue)(args, '--name');
        if (!name) {
            return (0, helpers_1.commandMissingFlag)('--name');
        }
        try {
            const record = await (0, rootOwnerIdentity_1.renameRootOwnerIdentity)(systemHomeDir, name);
            return (0, commandResult_1.commandSuccess)({ identity: (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record) });
        }
        catch (error) {
            return rootOwnerFailure(error);
        }
    }
    if (subcommand === 'reveal') {
        try {
            const mnemonic = await (0, rootOwnerIdentity_1.revealRootOwnerMnemonic)(systemHomeDir);
            return (0, commandResult_1.commandSuccess)({ mnemonic });
        }
        catch (error) {
            return rootOwnerFailure(error);
        }
    }
    if (subcommand === 'bind-device') {
        // Sign (root owner key) + publish (device identity) the /info/owner
        // device→owner binding pin. The publish happens daemon-side (signer +
        // traffic sponsor hook live there); the CLI only forwards.
        const handler = context.dependencies.owner?.bindDevice;
        if (!handler) {
            return (0, commandResult_1.commandFailed)('not_implemented', 'Owner bind-device handler is not configured. Is the daemon running a build that supports it?');
        }
        return handler();
    }
    return (0, helpers_1.commandUnknownSubcommand)(`owner ${(0, helpers_1.redactSensitiveArgs)(args).join(' ')}`.trim());
}
