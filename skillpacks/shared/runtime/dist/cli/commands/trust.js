"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTrustCommand = runTrustCommand;
const commandResult_1 = require("../../core/contracts/commandResult");
const deriveIdentity_1 = require("../../core/identity/deriveIdentity");
const helpers_1 = require("./helpers");
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/**
 * The on-chain owner trust grants (trust tiers P2): the local root owner
 * publishes append-only /protocols/simpletrust pins. grant/revoke publish
 * (daemon-side, they need the owner signer); list resolves the effective
 * set (grants minus revokes) from chain through the daemon.
 */
async function runTrustCommand(args, context) {
    const subcommand = args[0];
    if (subcommand === 'list') {
        const handler = context.dependencies.trust?.list;
        if (!handler) {
            return (0, commandResult_1.commandFailed)('not_implemented', 'Trust list handler is not configured. Is the daemon running a build that supports it?');
        }
        return handler();
    }
    if (subcommand === 'grant') {
        const trustedOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)(args[1] ?? '');
        if (!trustedOwner) {
            return (0, commandResult_1.commandFailed)('invalid_trusted_owner', 'Usage: metabot trust grant <ownerGlobalMetaId> [--note <text>]');
        }
        const note = (0, helpers_1.readFlagValue)(args, '--note') ?? undefined;
        const handler = context.dependencies.trust?.grant;
        if (!handler) {
            return (0, commandResult_1.commandFailed)('not_implemented', 'Trust grant handler is not configured. Is the daemon running a build that supports it?');
        }
        return handler({ trustedOwner, note });
    }
    if (subcommand === 'revoke') {
        const target = normalizeText(args[1]);
        if (!target) {
            return (0, commandResult_1.commandFailed)('missing_revoke_target', 'Usage: metabot trust revoke <ownerGlobalMetaId | grantPinId>');
        }
        const handler = context.dependencies.trust?.revoke;
        if (!handler) {
            return (0, commandResult_1.commandFailed)('not_implemented', 'Trust revoke handler is not configured. Is the daemon running a build that supports it?');
        }
        return handler({ target });
    }
    return (0, helpers_1.commandUnknownSubcommand)(`trust ${(0, helpers_1.redactSensitiveArgs)(args).join(' ')}`.trim());
}
