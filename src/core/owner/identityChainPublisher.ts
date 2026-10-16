// Generalized chain publisher for non-profile identities (the Device
// Identity and the root Owner Identity): any machine-wide identity record
// can sign + broadcast its own pins through an identity signer
// (ownerSigner.ts) without a Bot profile home. This is the shared machinery
// behind the device→owner binding (deviceOwnerBinding.ts) and the owner
// trust grants (trust/trustGrantPins.ts).
//
// Funding (same policy as the P1 device binding): pin writes cost micro-fees
// on MVC, and device/owner wallets may hold zero balance. Publishing
// requests the idempotent MVC gas subsidy for the identity address first
// (the same service onboarding uses; "address already rewarded" counts as
// success) — but a subsidy failure does NOT abort the write, because the
// wallet may already be funded. Only when the write itself then fails do we
// surface a combined, actionable funding error.
import type { ChainWriteRequest, ChainWriteResult } from '../chain/writePin';
import type { OwnerIdentityRecord } from './ownerIdentity';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../subsidy/requestMvcGasSubsidy';
import type { Signer } from '../signing/signer';

export class IdentityPinPublishError extends Error {
  constructor(
    readonly code: 'chain_write_failed',
    message: string,
    readonly details?: { subsidyError?: string },
  ) {
    super(message);
    this.name = 'IdentityPinPublishError';
  }
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
export async function publishIdentityPin(input: {
  identity: Pick<OwnerIdentityRecord, 'mvcAddress' | 'mnemonic' | 'path'>;
  signer: Signer;
  request: ChainWriteRequest;
  requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishIdentityPinResult> {
  let subsidy: IdentityPinSubsidyOutcome = { requested: false, success: false };
  if (input.requestSubsidy) {
    let outcome: RequestMvcGasSubsidyResult;
    try {
      outcome = await input.requestSubsidy({
        mvcAddress: input.identity.mvcAddress,
        mnemonic: input.identity.mnemonic,
        path: input.identity.path,
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
    chainWrite = await input.signer.writePin(input.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (subsidy.requested && !subsidy.success) {
      throw new IdentityPinPublishError(
        'chain_write_failed',
        `Publishing the pin failed (${message}) and the MVC gas subsidy could not fund `
        + `the identity address${subsidy.error ? ` (${subsidy.error})` : ''}. Top up the identity MVC wallet `
        + `(${input.identity.mvcAddress}) with a small amount of SPACE and retry.`,
        { subsidyError: subsidy.error },
      );
    }
    throw new IdentityPinPublishError('chain_write_failed', message, { subsidyError: subsidy.error });
  }

  return { chainWrite, subsidy };
}
