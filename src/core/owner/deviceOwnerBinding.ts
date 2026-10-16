// Device -> Owner binding publish: the DEVICE identity (the machine-wide
// identity in `~/.metabot/owner/identity.json`, semantically the Device
// Identity) publishes an /info/owner pin whose payload embeds the ROOT OWNER
// identity's signature over `metabot-owner-binding:<deviceGlobalMetaId>`.
// The wire format, signing, and offline verification are exactly the Bot ->
// Device binding of ownerBinding.ts (`07-owner-binding`), with the Device as
// the subject — the protocol's generalized semantics: the /info/owner of X
// is the identity directly accountable for X.
//
// Funding: pin writes cost micro-fees on MVC. Publishing requests the
// idempotent MVC gas subsidy for the device address first (same service the
// onboarding pipeline uses; "address already rewarded" counts as success) —
// but a subsidy failure does NOT abort the write, because the device wallet
// may already be funded. Only when the write itself then fails do we surface
// a combined, actionable funding error.
import type { ChainWriteResult } from '../chain/writePin';
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

  let subsidy: DeviceOwnerBindingSubsidyOutcome = { requested: false, success: false };
  if (input.requestSubsidy) {
    let outcome: RequestMvcGasSubsidyResult;
    try {
      outcome = await input.requestSubsidy({
        mvcAddress: input.device.mvcAddress,
        mnemonic: input.device.mnemonic,
        path: input.device.path,
      });
    } catch (error) {
      outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    subsidy = {
      requested: true,
      success: outcome.success === true,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  let chainWrite: ChainWriteResult;
  try {
    chainWrite = await input.signer.writePin({
      operation: 'create',
      path: OWNER_BINDING_PATH,
      contentType: 'application/json',
      payload,
      encoding: 'utf-8',
      encryption: '0',
      version: '1.0',
      network: 'mvc',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (subsidy.requested && !subsidy.success) {
      throw new DeviceOwnerBindingError(
        'chain_write_failed',
        `Publishing the device→owner binding pin failed (${message}) and the MVC gas subsidy could not fund `
        + `the device address${subsidy.error ? ` (${subsidy.error})` : ''}. Top up the device MVC wallet `
        + `(${input.device.mvcAddress}) with a small amount of SPACE and retry.`,
        { subsidyError: subsidy.error },
      );
    }
    throw new DeviceOwnerBindingError('chain_write_failed', message, { subsidyError: subsidy.error });
  }

  return { payload, chainWrite, subsidy };
}
