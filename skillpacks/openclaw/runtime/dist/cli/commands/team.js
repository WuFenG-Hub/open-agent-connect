"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTeamCommand = runTeamCommand;
const commandResult_1 = require("../../core/contracts/commandResult");
const deriveIdentity_1 = require("../../core/identity/deriveIdentity");
const helpers_1 = require("./helpers");
function normalizeText(value) {
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
async function runTeamCommand(args, context) {
    const subcommand = args[0];
    if (subcommand === 'list') {
        const handler = context.dependencies.team?.list;
        if (!handler) {
            return (0, commandResult_1.commandFailed)('not_implemented', 'Team list handler is not configured. Is the daemon running a build that supports it?');
        }
        return handler({});
    }
    if (subcommand === 'add' || subcommand === 'remove') {
        const globalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(args[1] ?? '');
        if (!globalMetaId) {
            return (0, commandResult_1.commandFailed)('invalid_global_meta_id', `Usage: metabot team ${subcommand} <globalMetaId>`);
        }
        const handler = context.dependencies.team?.[subcommand];
        if (!handler) {
            return (0, commandResult_1.commandFailed)('not_implemented', `Team ${subcommand} handler is not configured. Is the daemon running a build that supports it?`);
        }
        return handler({ globalMetaId });
    }
    return (0, helpers_1.commandUnknownSubcommand)(`team ${(0, helpers_1.redactSensitiveArgs)(args).join(' ')}`.trim());
}
