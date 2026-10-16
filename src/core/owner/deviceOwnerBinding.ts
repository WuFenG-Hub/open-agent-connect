// Device -> Owner binding publish: the DEVICE identity (the machine-wide
// identity in `~/.metabot/owner/identity.json`, semantically the Device
// Identity) publishes an /info/owner pin whose payload embeds the ROOT OWNER
// identity's signature over `metabot-owner-binding:<deviceGlobalMetaId>`.
// The wire format, signing, and offline verification are exactly the Bot ->
// Device binding of ownerBinding.ts (`07-owner-binding`), with the Device as
// the subject — the protocol's generalized semantics: the /info/owner of X
// is the identity directly accountable for X.
//
// The broadcast itself (subsidy attempt + chain write + actionable funding
// error) is the shared identityChainPublisher machinery, so a non-profile
// identity (device or root owner) signs and pays for its own pins.
import type { ChainWriteResult } from '../chain/writePin';
import { IdentityPinPublishError, publishIdentityPin } from './identityChainPublisher';
import { OWNER_BINDING_PATH, signOwnerBinding } from './ownerBinding';
import type { OwnerIdentityRecord } from './ownerIdentity';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../subsidy/requestMvcGasSubsidy';
import type { Signer } from '../signing/signer';

export class DeviceOwnerBindingError extends Error {
  constructor(
    readonly code: 'invalid_subject' | 'chain_write_failed',
    message: string,
    readonly details?: { subsidyError?: string },
  ) {
    super(message);
    this.name = 'DeviceOwnerBindingError';
  }
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
export async function publishDeviceOwnerBinding(input: {
  device: Pick<OwnerIdentityRecord, 'globalMetaId' | 'mvcAddress' | 'mnemonic' | 'path'>;
  rootOwner: Pick<OwnerIdentityRecord, 'globalMetaId' | 'mnemonic' | 'path'>;
  signer: Signer;
  requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishDeviceOwnerBindingResult> {
  const deviceGlobalMetaId = (input.device.globalMetaId ?? '').trim();
  if (!deviceGlobalMetaId) {
    throw new DeviceOwnerBindingError('invalid_subject', 'The device identity has no globalMetaId.');
  }

  const { payload } = await signOwnerBinding(input.rootOwner, deviceGlobalMetaId);

  try {
    const { chainWrite, subsidy } = await publishIdentityPin({
      identity: input.device,
      signer: input.signer,
      requestSubsidy: input.requestSubsidy,
      request: {
        operation: 'create',
        path: OWNER_BINDING_PATH,
        contentType: 'application/json',
        payload,
        encoding: 'utf-8',
        encryption: '0',
        version: '1.0',
        network: 'mvc',
      },
    });
    return { payload, chainWrite, subsidy };
  } catch (error) {
    if (error instanceof IdentityPinPublishError) {
      throw new DeviceOwnerBindingError(error.code, error.message, error.details);
    }
    throw error;
  }
}
