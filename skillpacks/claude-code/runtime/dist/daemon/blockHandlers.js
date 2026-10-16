"use strict";
/**
 * Daemon-side blocklist handler group: the /api/block/* verbs (trust tiers
 * P2). Purely local — backed by `~/.metabot/owner/trust-local.json` via the
 * core trustLocalStore; add/remove also drop the peer's cached trust
 * resolution (blockGmid/unblockGmid composition), so the next tier check
 * never serves stale state for the changed peer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBlockDaemonHandlers = createBlockDaemonHandlers;
const commandResult_1 = require("../core/contracts/commandResult");
const deriveIdentity_1 = require("../core/identity/deriveIdentity");
const trustLocalStore_1 = require("../core/trust/trustLocalStore");
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function createBlockDaemonHandlers(input) {
    const systemHomeDir = input.systemHomeDir;
    return {
        list: async () => {
            const state = await (0, trustLocalStore_1.createTrustLocalStore)(systemHomeDir).read();
            return (0, commandResult_1.commandSuccess)(state);
        },
        add: async (rawInput) => {
            const globalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(normalizeText(rawInput?.globalMetaId));
            if (!globalMetaId) {
                return (0, commandResult_1.commandFailed)('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
            }
            try {
                const state = await (0, trustLocalStore_1.blockGmid)(systemHomeDir, globalMetaId);
                input.onTrustConfigChanged?.();
                return (0, commandResult_1.commandSuccess)({ blocked: state.blocked, added: globalMetaId });
            }
            catch (error) {
                return (0, commandResult_1.commandFailed)('block_add_failed', error instanceof Error ? error.message : String(error));
            }
        },
        remove: async (rawInput) => {
            const globalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(normalizeText(rawInput?.globalMetaId));
            if (!globalMetaId) {
                return (0, commandResult_1.commandFailed)('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
            }
            try {
                const state = await (0, trustLocalStore_1.unblockGmid)(systemHomeDir, globalMetaId);
                input.onTrustConfigChanged?.();
                return (0, commandResult_1.commandSuccess)({ blocked: state.blocked, removed: globalMetaId });
            }
            catch (error) {
                return (0, commandResult_1.commandFailed)('block_remove_failed', error instanceof Error ? error.message : String(error));
            }
        },
    };
}
