"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdentityPinPublishError = void 0;
exports.publishIdentityPin = publishIdentityPin;
class IdentityPinPublishError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'IdentityPinPublishError';
    }
}
exports.IdentityPinPublishError = IdentityPinPublishError;
/**
 * Broadcast one pin authored by `identity` through `signer` (created from
 * the identity's own mnemonic, see createOwnerSigner). Injected seams:
 * `requestSubsidy` funds a zero-balance wallet; omit it to skip the subsidy
 * attempt entirely.
 */
async function publishIdentityPin(input) {
    let subsidy = { requested: false, success: false };
    if (input.requestSubsidy) {
        let outcome;
        try {
            outcome = await input.requestSubsidy({
                mvcAddress: input.identity.mvcAddress,
                mnemonic: input.identity.mnemonic,
                path: input.identity.path,
            });
        }
        catch (error) {
            outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        subsidy = {
            requested: true,
            success: outcome.success === true,
            ...(outcome.error ? { error: outcome.error } : {}),
        };
    }
    let chainWrite;
    try {
        chainWrite = await input.signer.writePin(input.request);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (subsidy.requested && !subsidy.success) {
            throw new IdentityPinPublishError('chain_write_failed', `Publishing the pin failed (${message}) and the MVC gas subsidy could not fund `
                + `the identity address${subsidy.error ? ` (${subsidy.error})` : ''}. Top up the identity MVC wallet `
                + `(${input.identity.mvcAddress}) with a small amount of SPACE and retry.`, { subsidyError: subsidy.error });
        }
        throw new IdentityPinPublishError('chain_write_failed', message, { subsidyError: subsidy.error });
    }
    return { chainWrite, subsidy };
}
