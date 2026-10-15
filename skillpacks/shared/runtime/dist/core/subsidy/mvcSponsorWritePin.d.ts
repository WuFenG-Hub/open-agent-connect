/**
 * Sponsored (traffic-mode, 代付) MVC pin-write orchestration.
 * Port of IDBots src/main/services/mvcSponsorCreatePin.ts onto OAC
 * primitives, mirroring src/core/files/mvcSponsorDirectUpload.ts idioms:
 * address-info preflight -> unsigned inscription draft (no fee deduction) ->
 * advisory quota check -> challenge -> bot signs the challenge ->
 * trafficAccount resolution -> pre -> sign user-owned inputs -> commit proof
 * -> commit, then pending-UTXO tracking + local spend journaling exactly like
 * the broadcast path.
 *
 * Fallback semantics (IDBots parity): service_unavailable / no_user_utxo /
 * insufficient_quota / insufficient_traffic fall back to the regular
 * self-paid write (result carries feeAssist metadata); pre_rejected remains
 * a hard failure carrying feeAssist diagnostics on error.data. A commit
 * failure whose sponsor order did not broadcast (broadcast errors like
 * txn-mempool-conflict on the sponsor's fee inputs) also falls back to the
 * MetaBot wallet: the drafted user inputs are journaled as pending-spent so
 * the self-paid rebuild cannot double-spend them. In traffic mode, failure
 * to resolve the traffic account is also service_unavailable: do not
 * continue with the legacy sponsor quota path when the configured traffic
 * interface is unavailable.
 */
import type { DerivedIdentity } from '../identity/deriveIdentity';
import type { ChainWriteResult, NormalizedChainWriteRequest } from '../chain/writePin';
import type { ChainUtxo } from '../chain/adapters/types';
import type { ResolveSponsorWritePin } from '../signing/localMnemonicSigner';
import type { MvcSponsorAddressInfo, MvcSponsorChallenge, MvcSponsorCommitResult, MvcSponsorOrder, MvcSponsorPreResult, MvcSponsorTrafficAccount } from './mvcSponsorV2Client';
import { type MvcSponsorTrafficDeps } from './feeAssist';
import type { TrafficAccountService } from '../traffic/trafficAccountService';
/** Reasons that fall back to the regular self-paid write (IDBots parity). */
export type MvcSponsorWritePinFallbackReason = 'service_unavailable' | 'no_user_utxo' | 'insufficient_quota' | 'insufficient_traffic' | 'commit_failed';
/** Minimal sponsor-client surface used by the pin-write flow. */
export interface MvcSponsorWritePinClient {
    getAddressInfo(payload: {
        address: string;
    }): Promise<MvcSponsorAddressInfo>;
    getChallenge(): Promise<MvcSponsorChallenge>;
    preSponsor(payload: {
        address: string;
        txHex: string;
        challengeId: string;
        publicKey: string;
        signature: string;
        trafficAccount?: MvcSponsorTrafficAccount;
    }): Promise<MvcSponsorPreResult>;
    commitSponsor(payload: {
        orderId: string;
        signedTxHex: string;
        publicKey: string;
        signature: string;
        message?: string;
    }): Promise<MvcSponsorCommitResult>;
    /** Optional order-status probe used by the commit-failure fallback. */
    getSponsorOrder?(payload: {
        orderId: string;
    }): Promise<MvcSponsorOrder>;
}
export interface MvcSponsorWritePinInput {
    request: NormalizedChainWriteRequest;
    identity: DerivedIdentity;
    sponsorClient: MvcSponsorWritePinClient;
    traffic: MvcSponsorTrafficDeps;
    /** Regular self-paid build+broadcast worker (the signer's existing body). */
    runSelfPaid: () => Promise<ChainWriteResult>;
    /** Test seam; defaults to the MVC chain adapter UTXO fetch. */
    fetchUtxos?: (address: string) => Promise<ChainUtxo[]>;
}
export declare function writeMvcSponsorPin(input: MvcSponsorWritePinInput): Promise<ChainWriteResult>;
/**
 * Build the signer's resolveSponsorWritePin hook bound to a shared traffic
 * account service. Returns null (unchanged self-paid behavior) unless the
 * stored traffic pin mode is 'traffic'; otherwise returns null. When traffic
 * mode is active but the account cannot be resolved, the write flow falls
 * back to the MetaBot's own wallet before contacting the legacy quota path.
 */
export declare function createTrafficSponsorWritePinResolver(input: {
    trafficAccountService: Pick<TrafficAccountService, 'getTrafficPinMode' | 'getConfiguredTrafficApiBase' | 'resolveSponsorTrafficAccount' | 'recordLocalTrafficSpend'>;
}): ResolveSponsorWritePin;
