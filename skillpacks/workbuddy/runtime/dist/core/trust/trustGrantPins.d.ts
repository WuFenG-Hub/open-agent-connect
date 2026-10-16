import type { ChainWriteResult } from '../chain/writePin';
import { type IdentityPinSubsidyOutcome } from '../owner/identityChainPublisher';
import type { OwnerIdentityRecord } from '../owner/ownerIdentity';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../subsidy/requestMvcGasSubsidy';
import type { Signer } from '../signing/signer';
export declare const SIMPLETRUST_PATH = "/protocols/simpletrust";
export declare const SIMPLETRUST_VERSION = 1;
export declare class TrustGrantError extends Error {
    readonly code: 'invalid_trusted_owner' | 'invalid_revoke_target';
    constructor(code: 'invalid_trusted_owner' | 'invalid_revoke_target', message: string);
}
export interface TrustGrantPayload {
    version: number;
    trustedOwner: string;
    note?: string;
    ts: number;
}
export interface TrustRevokePayload {
    version: number;
    revoke: string;
    ts: number;
}
export type ParsedSimpletrustPin = {
    kind: 'grant';
    trustedOwner: string;
    note?: string;
    ts: number;
} | {
    kind: 'revoke';
    revoke: string;
    ts: number;
};
export declare function buildTrustGrantPayload(input: {
    trustedOwner: string;
    note?: string;
    ts: number;
}): string;
export declare function buildTrustRevokePayload(input: {
    revoke: string;
    ts: number;
}): string;
/** Lenient parser: returns null for anything that is not a well-formed simpletrust pin. */
export declare function parseSimpletrustPin(raw: string | null | undefined): ParsedSimpletrustPin | null;
export interface PublishTrustGrantResult {
    payload: string;
    chainWrite: ChainWriteResult;
    subsidy: IdentityPinSubsidyOutcome;
}
/** Publish one trust grant pin from the owner identity (`signer` = owner signer). */
export declare function publishTrustGrant(input: {
    owner: Pick<OwnerIdentityRecord, 'mvcAddress' | 'mnemonic' | 'path'>;
    trustedOwner: string;
    note?: string;
    ts?: number;
    signer: Signer;
    requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishTrustGrantResult>;
/** Publish one revoke pin cancelling the grant named by `revoke` (a grant pinId). */
export declare function publishTrustRevoke(input: {
    owner: Pick<OwnerIdentityRecord, 'mvcAddress' | 'mnemonic' | 'path'>;
    revoke: string;
    ts?: number;
    signer: Signer;
    requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishTrustGrantResult>;
