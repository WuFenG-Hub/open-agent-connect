/**
 * Daemon-side trust-grant handler group: the /api/trust/* verbs backing the
 * `metabot trust *` CLI surface (trust tiers P2). Grant/revoke pins publish
 * from the root Owner Identity (signer + subsidy live daemon-side, same as
 * the P1 bind-device flow); `list` resolves the local owner's effective
 * trust set from chain through the trustedOwnerResolver (cache-first).
 */
import type { OwnerIdentityRecord } from '../core/owner/ownerIdentity';
import { type TrustedOwnerResolver } from '../core/trust/trustedOwnerResolver';
import type { ChainAdapterRegistry } from '../core/chain/adapters/types';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../core/subsidy/requestMvcGasSubsidy';
import type { ResolveSponsorWritePin } from '../core/signing/localMnemonicSigner';
import type { Signer } from '../core/signing/signer';
import type { MetabotDaemonHttpHandlers } from './routes/types';
export interface TrustDaemonHandlersInput {
    /** The machine-wide system home that owns `~/.metabot/owner/`. */
    systemHomeDir: string;
    /** Chain adapters for the owner signer used by grant/revoke. */
    adapters?: ChainAdapterRegistry;
    /** MVC traffic (代付) sponsor hook for the owner signer; absent = self-pay. */
    resolveSponsorWritePin?: ResolveSponsorWritePin;
    /** Test seam: full override of the owner signer construction. */
    createSigner?: (owner: OwnerIdentityRecord) => Signer;
    /** Subsidy seam for grant/revoke; defaults to the real MVC gas subsidy service. */
    requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
    /** Test seam: full override of the trusted-owner resolver. */
    trustedOwnerResolver?: TrustedOwnerResolver;
    /** Called after a successful grant/revoke so consumers (e.g. the P3 peer
     *  tier resolver's short-TTL cache) can drop stale tier entries. */
    onTrustConfigChanged?: () => void;
}
export declare function createTrustDaemonHandlers(input: TrustDaemonHandlersInput): NonNullable<MetabotDaemonHttpHandlers['trust']>;
