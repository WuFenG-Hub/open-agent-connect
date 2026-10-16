/**
 * Daemon-side root-owner handler group: the /api/owner/* verbs backing the
 * `metabot owner *` CLI surface (trust tiers P1). Thin ports over
 * core/owner/rootOwnerIdentity plus the device->owner binding publish
 * (core/owner/deviceOwnerBinding): the write that needs chain access
 * (`bindDevice`) runs daemon-side where the adapters and the traffic sponsor
 * hook live; the CRUD verbs are local file operations.
 */
import { type OwnerIdentityRecord } from '../core/owner/ownerIdentity';
import type { ChainAdapterRegistry } from '../core/chain/adapters/types';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../core/subsidy/requestMvcGasSubsidy';
import type { ResolveSponsorWritePin } from '../core/signing/localMnemonicSigner';
import type { Signer } from '../core/signing/signer';
import type { MetabotDaemonHttpHandlers } from './routes/types';
export interface OwnerDaemonHandlersInput {
    /** The machine-wide system home that owns `~/.metabot/owner/`. */
    systemHomeDir: string;
    /** Chain adapters for the device signer used by `bindDevice`. */
    adapters?: ChainAdapterRegistry;
    /** MVC traffic (代付) sponsor hook for the device signer; absent = self-pay. */
    resolveSponsorWritePin?: ResolveSponsorWritePin;
    /** Test seam: full override of the device signer construction. */
    createSigner?: (identity: OwnerIdentityRecord) => Signer;
    /** Subsidy seam for `bindDevice`; defaults to the real MVC gas subsidy service. */
    requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}
export declare function createOwnerDaemonHandlers(input: OwnerDaemonHandlersInput): NonNullable<MetabotDaemonHttpHandlers['owner']>;
