import type { ChainWriteRequest, ChainWriteResult } from '../chain/writePin';
import type { OwnerIdentityRecord } from './ownerIdentity';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../subsidy/requestMvcGasSubsidy';
import type { Signer } from '../signing/signer';
export declare class IdentityPinPublishError extends Error {
    readonly code: 'chain_write_failed';
    readonly details?: {
        subsidyError?: string;
    } | undefined;
    constructor(code: 'chain_write_failed', message: string, details?: {
        subsidyError?: string;
    } | undefined);
}
export interface IdentityPinSubsidyOutcome {
    /** False when no subsidy request ran (no requestSubsidy dependency injected). */
    requested: boolean;
    success: boolean;
    error?: string;
}
export interface PublishIdentityPinResult {
    chainWrite: ChainWriteResult;
    subsidy: IdentityPinSubsidyOutcome;
}
/**
 * Broadcast one pin authored by `identity` through `signer` (created from
 * the identity's own mnemonic, see createOwnerSigner). Injected seams:
 * `requestSubsidy` funds a zero-balance wallet; omit it to skip the subsidy
 * attempt entirely.
 */
export declare function publishIdentityPin(input: {
    identity: Pick<OwnerIdentityRecord, 'mvcAddress' | 'mnemonic' | 'path'>;
    signer: Signer;
    request: ChainWriteRequest;
    requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishIdentityPinResult>;
