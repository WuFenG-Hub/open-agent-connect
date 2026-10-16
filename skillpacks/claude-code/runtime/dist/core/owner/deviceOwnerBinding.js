"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceOwnerBindingError = void 0;
exports.publishDeviceOwnerBinding = publishDeviceOwnerBinding;
const identityChainPublisher_1 = require("./identityChainPublisher");
const ownerBinding_1 = require("./ownerBinding");
class DeviceOwnerBindingError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'DeviceOwnerBindingError';
    }
}
exports.DeviceOwnerBindingError = DeviceOwnerBindingError;
/**
 * Sign the device->owner binding with the ROOT OWNER key and publish the
 * /info/owner pin FROM the device identity via `signer` (the device signer,
 * see ownerSigner.ts). The subsidy step funds a zero-balance device wallet;
 * inject `requestSubsidy` to enable it (the daemon passes the real service,
 * tests pass a stub).
 */
async function publishDeviceOwnerBinding(input) {
    const deviceGlobalMetaId = (input.device.globalMetaId ?? '').trim();
    if (!deviceGlobalMetaId) {
        throw new DeviceOwnerBindingError('invalid_subject', 'The device identity has no globalMetaId.');
    }
    const { payload } = await (0, ownerBinding_1.signOwnerBinding)(input.rootOwner, deviceGlobalMetaId);
    try {
        const { chainWrite, subsidy } = await (0, identityChainPublisher_1.publishIdentityPin)({
            identity: input.device,
            signer: input.signer,
            requestSubsidy: input.requestSubsidy,
            request: {
                operation: 'create',
                path: ownerBinding_1.OWNER_BINDING_PATH,
                contentType: 'application/json',
                payload,
                encoding: 'utf-8',
                encryption: '0',
                version: '1.0',
                network: 'mvc',
            },
        });
        return { payload, chainWrite, subsidy };
    }
    catch (error) {
        if (error instanceof identityChainPublisher_1.IdentityPinPublishError) {
            throw new DeviceOwnerBindingError(error.code, error.message, error.details);
        }
        throw error;
    }
}
