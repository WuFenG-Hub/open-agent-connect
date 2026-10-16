"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBlockCommand = runBlockCommand;
const commandResult_1 = require("../../core/contracts/commandResult");
const deriveIdentity_1 = require("../../core/identity/deriveIdentity");
const trustLocalStore_1 = require("../../core/trust/trustLocalStore");
const homeSelection_1 = require("../../core/state/homeSelection");
const helpers_1 = require("./helpers");
/**
 * The device-level blocklist (trust tiers P2, M1): pure local state at
 * `~/.metabot/owner/trust-local.json` — no daemon required. add/remove also
 * drop the peer's cached trust resolution (blockGmid/unblockGmid), so the
 * next tier check re-resolves. On-chain `simpleblock` replaces/merges this
 * in M2.
 */
async function runBlockCommand(args, context) {
    const subcommand = args[0];
    const systemHomeDir = (0, homeSelection_1.normalizeSystemHomeDir)(context.env, context.cwd);
    const store = (0, trustLocalStore_1.createTrustLocalStore)(systemHomeDir);
    if (subcommand === 'list') {
        return (0, commandResult_1.commandSuccess)(await store.read());
    }
    if (subcommand === 'add' || subcommand === 'remove') {
        const globalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(args[1] ?? '');
        if (!globalMetaId) {
            return (0, commandResult_1.commandFailed)('invalid_global_meta_id', `Usage: metabot block ${subcommand} <globalMetaId>`);
        }
        const state = subcommand === 'add'
            ? await (0, trustLocalStore_1.blockGmid)(systemHomeDir, globalMetaId)
            : await (0, trustLocalStore_1.unblockGmid)(systemHomeDir, globalMetaId);
        return (0, commandResult_1.commandSuccess)({
            blocked: state.blocked,
            [subcommand === 'add' ? 'added' : 'removed']: globalMetaId,
        });
    }
    return (0, helpers_1.commandUnknownSubcommand)(`block ${(0, helpers_1.redactSensitiveArgs)(args).join(' ')}`.trim());
}
