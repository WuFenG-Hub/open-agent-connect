"use strict";
/**
 * Daemon-side trust-grant handler group: the /api/trust/* verbs backing the
 * `metabot trust *` CLI surface (trust tiers P2). Grant/revoke pins publish
 * from the root Owner Identity (signer + subsidy live daemon-side, same as
 * the P1 bind-device flow); `list` resolves the local owner's effective
 * trust set from chain through the trustedOwnerResolver (cache-first).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTrustDaemonHandlers = createTrustDaemonHandlers;
const commandResult_1 = require("../core/contracts/commandResult");
const deriveIdentity_1 = require("../core/identity/deriveIdentity");
const ownerSigner_1 = require("../core/owner/ownerSigner");
const rootOwnerIdentity_1 = require("../core/owner/rootOwnerIdentity");
const identityChainPublisher_1 = require("../core/owner/identityChainPublisher");
const trustGrantPins_1 = require("../core/trust/trustGrantPins");
const trustedOwnerResolver_1 = require("../core/trust/trustedOwnerResolver");
function trustFailure(error, fallbackCode) {
    if (error instanceof trustGrantPins_1.TrustGrantError) {
        return (0, commandResult_1.commandFailed)(error.code, error.message);
    }
    if (error instanceof identityChainPublisher_1.IdentityPinPublishError) {
        return (0, commandResult_1.commandFailed)(error.code, error.message);
    }
    return (0, commandResult_1.commandFailed)(fallbackCode, error instanceof Error ? error.message : String(error));
}
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** A revoke target is either a grant pinId (64-hex + i<n>) or a GlobalMetaID. */
function looksLikeGrantPinId(value) {
    return /^[0-9a-f]{64}i\d+$/i.test(value);
}
function createTrustDaemonHandlers(input) {
    const systemHomeDir = input.systemHomeDir;
    const resolver = input.trustedOwnerResolver
        ?? (0, trustedOwnerResolver_1.createTrustedOwnerResolver)({ systemHomeDir });
    async function requireRootOwner() {
        const rootOwner = await (0, rootOwnerIdentity_1.loadRootOwnerIdentity)(systemHomeDir);
        if (!rootOwner) {
            return (0, commandResult_1.commandFailed)('root_owner_missing', 'No root owner identity exists on this machine. Create one with `metabot owner create` or import it with `metabot owner import --mnemonic-stdin` first.');
        }
        return rootOwner;
    }
    function resolveSigner(rootOwner) {
        return input.createSigner
            ? input.createSigner(rootOwner)
            : input.adapters
                ? (0, ownerSigner_1.createOwnerSigner)({
                    systemHomeDir,
                    owner: rootOwner,
                    adapters: input.adapters,
                    ...(input.resolveSponsorWritePin ? { resolveSponsorWritePin: input.resolveSponsorWritePin } : {}),
                })
                : null;
    }
    return {
        /** Effective trust set the local root owner has granted (chain-resolved, cache-first). */
        list: async () => {
            const rootOwner = await requireRootOwner();
            if (!('mnemonic' in rootOwner))
                return rootOwner;
            try {
                const resolution = await resolver.resolveTrustedOwners(rootOwner.globalMetaId);
                return (0, commandResult_1.commandSuccess)({
                    owner: rootOwner.globalMetaId,
                    trustedOwners: resolution.trustedOwners,
                    fromCache: resolution.fromCache,
                });
            }
            catch (error) {
                return trustFailure(error, 'trust_list_failed');
            }
        },
        grant: async (rawInput) => {
            const rootOwner = await requireRootOwner();
            if (!('mnemonic' in rootOwner))
                return rootOwner;
            const trustedOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)(normalizeText(rawInput?.trustedOwner));
            if (!trustedOwner) {
                return (0, commandResult_1.commandFailed)('invalid_trusted_owner', 'trustedOwner must be a valid GlobalMetaID.');
            }
            const signer = resolveSigner(rootOwner);
            if (!signer) {
                return (0, commandResult_1.commandFailed)('chain_unavailable', 'Chain publish is not configured in this daemon.');
            }
            const note = normalizeText(rawInput?.note) || undefined;
            try {
                const result = await (0, trustGrantPins_1.publishTrustGrant)({
                    owner: rootOwner,
                    trustedOwner,
                    note,
                    signer,
                    ...(input.requestSubsidy ? { requestSubsidy: input.requestSubsidy } : {}),
                });
                // The owner's own grants changed — drop the stale cache entry.
                await resolver.invalidate(rootOwner.globalMetaId);
                input.onTrustConfigChanged?.();
                return (0, commandResult_1.commandSuccess)({
                    trustGrant: {
                        owner: rootOwner.globalMetaId,
                        trustedOwner,
                        note: note ?? null,
                        path: '/protocols/simpletrust',
                        pinId: result.chainWrite.pinId,
                    },
                    subsidy: result.subsidy,
                    chainWrites: [result.chainWrite],
                });
            }
            catch (error) {
                return trustFailure(error, 'trust_grant_failed');
            }
        },
        revoke: async (rawInput) => {
            const rootOwner = await requireRootOwner();
            if (!('mnemonic' in rootOwner))
                return rootOwner;
            const target = normalizeText(rawInput?.target);
            if (!target) {
                return (0, commandResult_1.commandFailed)('missing_revoke_target', 'target (owner GlobalMetaID or grant pinId) is required.');
            }
            const signer = resolveSigner(rootOwner);
            if (!signer) {
                return (0, commandResult_1.commandFailed)('chain_unavailable', 'Chain publish is not configured in this daemon.');
            }
            try {
                // A gmid target revokes every effective grant to that owner; a pinId
                // target revokes exactly the grant it names.
                const revokePinIds = [];
                if ((0, deriveIdentity_1.normalizeGlobalMetaId)(target)) {
                    const resolution = await resolver.resolveTrustedOwners(rootOwner.globalMetaId);
                    const matching = resolution.trustedOwners.filter((grant) => grant.trustedOwner === (0, deriveIdentity_1.normalizeGlobalMetaId)(target));
                    if (matching.length === 0) {
                        return (0, commandResult_1.commandFailed)('trust_grant_not_found', `No effective trust grant to ${target}. Nothing to revoke.`);
                    }
                    revokePinIds.push(...matching.map((grant) => grant.grantPinId));
                }
                else if (looksLikeGrantPinId(target)) {
                    revokePinIds.push(target);
                }
                else {
                    return (0, commandResult_1.commandFailed)('invalid_revoke_target', 'target must be an owner GlobalMetaID or a grant pinId (<txid>i<n>).');
                }
                const chainWrites = [];
                for (const revoke of revokePinIds) {
                    const result = await (0, trustGrantPins_1.publishTrustRevoke)({
                        owner: rootOwner,
                        revoke,
                        signer,
                        ...(input.requestSubsidy ? { requestSubsidy: input.requestSubsidy } : {}),
                    });
                    chainWrites.push(result.chainWrite);
                }
                await resolver.invalidate(rootOwner.globalMetaId);
                input.onTrustConfigChanged?.();
                return (0, commandResult_1.commandSuccess)({
                    revoked: revokePinIds,
                    owner: rootOwner.globalMetaId,
                    chainWrites,
                });
            }
            catch (error) {
                return trustFailure(error, 'trust_revoke_failed');
            }
        },
    };
}
