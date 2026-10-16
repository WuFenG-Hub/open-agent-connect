"use strict";
/**
 * Daemon-side team handler group: the /api/team/* verbs backing the
 * `metabot team *` CLI surface (trust tiers P5). The team registry lists
 * REMOTE Bots bound to the same root owner — candidates for cross-device
 * group-task seating. `add` verifies the peer's root owner == my root owner
 * on-chain before recording; `list` combines local profiles with registry
 * entries (manual + auto-recorded).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTeamDaemonHandlers = createTeamDaemonHandlers;
const commandResult_1 = require("../core/contracts/commandResult");
const deriveIdentity_1 = require("../core/identity/deriveIdentity");
const identityProfiles_1 = require("../core/identity/identityProfiles");
const ownerIdentity_1 = require("../core/owner/ownerIdentity");
const teamRegistryStore_1 = require("../core/trust/teamRegistryStore");
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function createTeamDaemonHandlers(input) {
    const systemHomeDir = input.systemHomeDir;
    const registry = (0, teamRegistryStore_1.createTeamRegistryStore)(systemHomeDir);
    return {
        list: async () => {
            const profiles = (await (0, identityProfiles_1.listIdentityProfiles)(systemHomeDir).catch(() => []))
                .map((profile) => ({
                slug: profile.slug,
                name: profile.name,
                globalMetaId: (0, deriveIdentity_1.normalizeGlobalMetaId)(profile.globalMetaId),
                local: true,
                source: 'local',
            }));
            const registryEntries = (await registry.list())
                .map((entry) => ({ ...entry, local: false }));
            return (0, commandResult_1.commandSuccess)({ profiles, registry: registryEntries });
        },
        add: async (rawInput) => {
            const globalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(normalizeText(rawInput?.globalMetaId));
            if (!globalMetaId) {
                return (0, commandResult_1.commandFailed)('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
            }
            if (!input.rootOwnerResolver) {
                return (0, commandResult_1.commandFailed)('team_verification_unavailable', 'Root-owner verification is not wired in this daemon; cannot verify team membership.');
            }
            const device = await (0, ownerIdentity_1.readOwnerIdentity)(systemHomeDir).catch(() => null);
            if (!device) {
                return (0, commandResult_1.commandFailed)('device_identity_missing', 'No device identity on this machine. Finish onboarding first.');
            }
            try {
                const myRootOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)((await input.rootOwnerResolver.resolveRootOwner(device.globalMetaId)).rootOwnerGlobalMetaId);
                const peerRootOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)((await input.rootOwnerResolver.resolveRootOwner(globalMetaId)).rootOwnerGlobalMetaId);
                if (!myRootOwner || !peerRootOwner || peerRootOwner !== myRootOwner) {
                    return (0, commandResult_1.commandFailed)('team_not_same_owner', `${globalMetaId} is not bound to your root owner (its root owner: ${peerRootOwner ?? 'unresolvable'}; yours: ${myRootOwner ?? 'unresolvable'}). Only Bots from the same owner team can be added.`);
                }
                const entries = await registry.upsert({
                    globalMetaId,
                    source: 'manual',
                    addedAt: new Date().toISOString(),
                });
                return (0, commandResult_1.commandSuccess)({ entry: entries.find((entry) => entry.globalMetaId === globalMetaId), registry: entries });
            }
            catch (error) {
                return (0, commandResult_1.commandFailed)('team_root_owner_unresolved', `Could not verify ${globalMetaId}'s root owner: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
        remove: async (rawInput) => {
            const globalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(normalizeText(rawInput?.globalMetaId));
            if (!globalMetaId) {
                return (0, commandResult_1.commandFailed)('invalid_global_meta_id', 'globalMetaId must be a valid GlobalMetaID.');
            }
            try {
                const entries = await registry.remove(globalMetaId);
                return (0, commandResult_1.commandSuccess)({ removed: globalMetaId, registry: entries });
            }
            catch (error) {
                return (0, commandResult_1.commandFailed)('team_remove_failed', error instanceof Error ? error.message : String(error));
            }
        },
    };
}
