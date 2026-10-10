/**
 * Sponsored (traffic-mode / quota, 代付) MVC large-upload merge funding.
 * Mirrors mvcSponsorDirectUpload.ts semantics onto the MetaFS chunked path:
 * the merge-transaction draft anchors on a single wallet UTXO whose full value
 * returns as change, while the sponsor funds the chunk/index pre-funding
 * outputs, so the on-chain cost lands on the traffic account (or the legacy
 * quota) instead of the bot wallet — same billing model as a sponsored direct
 * upload, where the sponsor's contribution is proportional to the upload.
 *
 * Fallback contract: every failure BEFORE commitSponsor throws a
 * MvcSponsorLargeUploadFallbackError (reason/stage recorded) so the caller can
 * fall back to the wallet-funded path. After commit the merge transaction is
 * on-chain and the anchor UTXO is spent, so later failures throw coded errors
 * without any fallback (a wallet retry could double-spend the anchor). This
 * deliberately widens the direct-upload fallback set (which hard-fails on
 * pre_rejected) because merge-shaped drafts are a newer sponsor payload; in
 * the worst case the uploader keeps today's wallet behavior.
 */
import type { DerivedIdentity } from '../identity/deriveIdentity';
import type { ChainUtxo } from '../chain/adapters/types';
import type { MvcSponsorAddressInfo } from '../subsidy/mvcSponsorV2Client';
import { type MvcSponsorFeeAssistMetadata, type MvcSponsorFeeAssistReason, type MvcSponsorFeeAssistStage } from '../subsidy/feeAssist';
import type { MvcSponsorV2DirectUploadClient } from './mvcSponsorDirectUpload';
export interface MvcSponsorLargeUploadFallback {
    reason: MvcSponsorFeeAssistReason;
    stage: MvcSponsorFeeAssistStage;
    quotaBefore?: MvcSponsorAddressInfo;
    advisoryFeeEstimate?: number;
}
export type MvcSponsorLargeUploadFallbackError = Error & {
    sponsorFallback: MvcSponsorLargeUploadFallback;
};
export interface MvcSponsorLargeUploadFundingResult {
    mergeTxHex: string;
    mergeTxId: string;
    chunkPreTxHex: string;
    indexPreTxHex: string;
    chunkPreTxOutputAmount: number;
    indexPreTxOutputAmount: number;
    spentUtxos: ChainUtxo[];
    createdUtxos: ChainUtxo[];
    sponsoredMinerFee: number;
    orderId: string;
    quotaBefore?: MvcSponsorAddressInfo;
    quotaAfter?: MvcSponsorAddressInfo;
    billedBy: 'traffic' | 'quota';
    feeAssist: MvcSponsorFeeAssistMetadata;
}
export declare function isMvcSponsorLargeUploadFallbackError(error: unknown): error is MvcSponsorLargeUploadFallbackError;
export declare function sponsorMvcLargeUploadFunding(input: {
    identity: DerivedIdentity;
    address: string;
    feeRate: number;
    chunkPreTxFee: number;
    indexPreTxFee: number;
    utxos: ChainUtxo[];
    sponsorClient: MvcSponsorV2DirectUploadClient;
}): Promise<MvcSponsorLargeUploadFundingResult>;
