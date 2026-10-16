"use strict";
/**
 * Daemon-side root-owner handler group: the /api/owner/* verbs backing the
 * `metabot owner *` CLI surface (trust tiers P1). Thin ports over
 * core/owner/rootOwnerIdentity plus the device->owner binding publish
 * (core/owner/deviceOwnerBinding): the write that needs chain access
 * (`bindDevice`) runs daemon-side where the adapters and the traffic sponsor
 * hook live; the CRUD verbs are local file operations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOwnerDaemonHandlers = createOwnerDaemonHandlers;
const commandResult_1 = require("../core/contracts/commandResult");
const deviceOwnerBinding_1 = require("../core/owner/deviceOwnerBinding");
const ownerBinding_1 = require("../core/owner/ownerBinding");
const ownerIdentity_1 = require("../core/owner/ownerIdentity");
const ownerSigner_1 = require("../core/owner/ownerSigner");
const rootOwnerIdentity_1 = require("../core/owner/rootOwnerIdentity");
function rootOwnerFailure(error) {
    if (error instanceof rootOwnerIdentity_1.RootOwnerIdentityError) {
        return (0, commandResult_1.commandFailed)(error.code, error.message);
    }
    return (0, commandResult_1.commandFailed)('root_owner_failed', error instanceof Error ? error.message : String(error));
}
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function createOwnerDaemonHandlers(input) {
    const systemHomeDir = input.systemHomeDir;
    return {
        who: async () => {
            const record = await (0, rootOwnerIdentity_1.loadRootOwnerIdentity)(systemHomeDir);
            return (0, commandResult_1.commandSuccess)({ identity: record ? (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record) : null });
        },
        create: async (rawInput) => {
            try {
                const record = await (0, rootOwnerIdentity_1.createRootOwnerIdentity)(systemHomeDir, { name: normalizeText(rawInput?.name) });
                // The mnemonic is shown exactly once, same as the device identity create.
                return (0, commandResult_1.commandSuccess)({ identity: (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record), mnemonic: record.mnemonic });
            }
            catch (error) {
                return rootOwnerFailure(error);
            }
        },
        import: async (rawInput) => {
            const mnemonic = normalizeText(rawInput?.mnemonic);
            if (!mnemonic) {
                return (0, commandResult_1.commandFailed)('missing_mnemonic', 'mnemonic is required.');
            }
            const derivationPath = normalizeText(rawInput?.path) || undefined;
            try {
                const record = await (0, rootOwnerIdentity_1.importRootOwnerIdentity)(systemHomeDir, {
                    name: normalizeText(rawInput?.name),
                    mnemonic,
                    ...(derivationPath ? { path: derivationPath } : {}),
                });
                return (0, commandResult_1.commandSuccess)({ identity: (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record), mnemonic: record.mnemonic });
            }
            catch (error) {
                return rootOwnerFailure(error);
            }
        },
        rename: async (rawInput) => {
            const name = normalizeText(rawInput?.name);
            if (!name) {
                return (0, commandResult_1.commandFailed)('missing_name', 'name is required.');
            }
            try {
                const record = await (0, rootOwnerIdentity_1.renameRootOwnerIdentity)(systemHomeDir, name);
                return (0, commandResult_1.commandSuccess)({ identity: (0, rootOwnerIdentity_1.toRootOwnerIdentityPublic)(record) });
            }
            catch (error) {
                return rootOwnerFailure(error);
            }
        },
        /**
         * Sign the device->owner binding with the ROOT OWNER key and publish the
         * /info/owner pin FROM the device identity (traffic-sponsored first,
         * subsidy-funded self-pay fallback). Idempotent payload-hash dedup makes
         * a re-bind after an already-published binding a no-op downstream.
         */
        bindDevice: async () => {
            try {
                const device = await (0, ownerIdentity_1.readOwnerIdentity)(systemHomeDir).catch(() => null);
                if (!device) {
                    return (0, commandResult_1.commandFailed)('device_identity_missing', 'No device identity exists on this machine. It is auto-created during onboarding; finish onboarding first.');
                }
                const rootOwner = await (0, rootOwnerIdentity_1.loadRootOwnerIdentity)(systemHomeDir);
                if (!rootOwner) {
                    return (0, commandResult_1.commandFailed)('root_owner_missing', 'No root owner identity exists on this machine. Create one with `metabot owner create` or import it with `metabot owner import --mnemonic-stdin` first.');
                }
                const signer = input.createSigner
                    ? input.createSigner(device)
                    : input.adapters
                        ? (0, ownerSigner_1.createOwnerSigner)({
                            systemHomeDir,
                            owner: device,
                            adapters: input.adapters,
                            ...(input.resolveSponsorWritePin ? { resolveSponsorWritePin: input.resolveSponsorWritePin } : {}),
                        })
                        : null;
                if (!signer) {
                    return (0, commandResult_1.commandFailed)('chain_unavailable', 'Chain publish is not configured in this daemon.');
                }
                const result = await (0, deviceOwnerBinding_1.publishDeviceOwnerBinding)({
                    device,
                    rootOwner,
                    signer,
                    ...(input.requestSubsidy ? { requestSubsidy: input.requestSubsidy } : {}),
                });
                return (0, commandResult_1.commandSuccess)({
                    ownerBinding: {
                        device: device.globalMetaId,
                        owner: rootOwner.globalMetaId,
                        path: ownerBinding_1.OWNER_BINDING_PATH,
                        pinId: result.chainWrite.pinId,
                    },
                    subsidy: result.subsidy,
                    chainWrites: [result.chainWrite],
                });
            }
            catch (error) {
                return (0, commandResult_1.commandFailed)('device_owner_bind_failed', error instanceof Error ? error.message : String(error));
            }
        },
    };
}
