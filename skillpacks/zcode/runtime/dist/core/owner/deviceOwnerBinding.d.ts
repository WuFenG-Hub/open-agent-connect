import type { ChainWriteResult } from '../chain/writePin';
import type { OwnerIdentityRecord } from './ownerIdentity';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../subsidy/requestMvcGasSubsidy';
import type { Signer } from '../signing/signer';
export declare class DeviceOwnerBindingError extends Error {
    readonly code: 'invalid_subject' | 'chain_write_failed';
    readonly details?: {
        subsidyError?: string;
    } | undefined;
    constructor(code: 'invalid_subject' | 'chain_write_failed', message: string, details?: {
        subsidyError?: string;
    } | undefined);
}
export interface DeviceOwnerBindingSubsidyOutcome {
    /** False when no subsidy request ran (no requestSubsidy dependency injected). */
    requested: boolean;
    success: boolean;
    error?: string;
}
export interface PublishDeviceOwnerBindingResult {
    /** The signed /info/owner payload (owner signature over the device gmid). */
    payload: string;
    chainWrite: ChainWriteResult;
    subsidy: DeviceOwnerBindingSubsidyOutcome;
}
/**
 * Sign the device->owner binding with the ROOT OWNER key and publish the
 * /info/owner pin FROM the device identity via `signer` (the device signer,
 * see ownerSigner.ts). The subsidy step funds a zero-balance device wallet;
 * inject `requestSubsidy` to enable it (the daemon passes the real service,
 * tests pass a stub).
 */
export declare function publishDeviceOwnerBinding(input: {
    device: Pick<OwnerIdentityRecord, 'globalMetaId' | 'mvcAddress' | 'mnemonic' | 'path'>;
    rootOwner: Pick<OwnerIdentityRecord, 'globalMetaId' | 'mnemonic' | 'path'>;
    signer: Signer;
    requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishDeviceOwnerBindingResult>;
