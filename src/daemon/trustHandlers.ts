/**
 * Daemon-side trust-grant handler group: the /api/trust/* verbs backing the
 * `metabot trust *` CLI surface (trust tiers P2). Grant/revoke pins publish
 * from the root Owner Identity (signer + subsidy live daemon-side, same as
 * the P1 bind-device flow); `list` resolves the local owner's effective
 * trust set from chain through the trustedOwnerResolver (cache-first).
 */

import {
  commandFailed,
  commandSuccess,
  type MetabotCommandResult,
} from '../core/contracts/commandResult';
import { normalizeGlobalMetaId } from '../core/identity/deriveIdentity';
import { createOwnerSigner } from '../core/owner/ownerSigner';
import type { OwnerIdentityRecord } from '../core/owner/ownerIdentity';
import { loadRootOwnerIdentity } from '../core/owner/rootOwnerIdentity';
import { IdentityPinPublishError } from '../core/owner/identityChainPublisher';
import { publishTrustGrant, publishTrustRevoke, TrustGrantError } from '../core/trust/trustGrantPins';
import {
  createTrustedOwnerResolver,
  type TrustedOwnerResolver,
} from '../core/trust/trustedOwnerResolver';
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
}

function trustFailure(error: unknown, fallbackCode: string): MetabotCommandResult<never> {
  if (error instanceof TrustGrantError) {
    return commandFailed(error.code, error.message);
  }
  if (error instanceof IdentityPinPublishError) {
    return commandFailed(error.code, error.message);
  }
  return commandFailed(fallbackCode, error instanceof Error ? error.message : String(error));
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A revoke target is either a grant pinId (64-hex + i<n>) or a GlobalMetaID. */
function looksLikeGrantPinId(value: string): boolean {
  return /^[0-9a-f]{64}i\d+$/i.test(value);
}

export function createTrustDaemonHandlers(
  input: TrustDaemonHandlersInput,
): NonNullable<MetabotDaemonHttpHandlers['trust']> {
  const systemHomeDir = input.systemHomeDir;
  const resolver = input.trustedOwnerResolver
    ?? createTrustedOwnerResolver({ systemHomeDir });

  async function requireRootOwner(): Promise<OwnerIdentityRecord | MetabotCommandResult<never>> {
    const rootOwner = await loadRootOwnerIdentity(systemHomeDir);
    if (!rootOwner) {
      return commandFailed(
        'root_owner_missing',
        'No root owner identity exists on this machine. Create one with `metabot owner create` or import it with `metabot owner import --mnemonic-stdin` first.',
      );
    }
    return rootOwner;
  }

  function resolveSigner(rootOwner: OwnerIdentityRecord): Signer | null {
    return input.createSigner
      ? input.createSigner(rootOwner)
      : input.adapters
        ? createOwnerSigner({
          systemHomeDir,
          owner: rootOwner,
          adapters: input.adapters,
          ...(input.resolveSponsorWritePin ? { resolveSponsorWritePin: input.resolveSponsorWritePin } : {}),
        })
        : null;
  }

  return {
    /** Effective trust set the local root owner has granted (chain-resolved, cache-first). */
    list: async () => {
      const rootOwner = await requireRootOwner();
      if (!('mnemonic' in rootOwner)) return rootOwner;
      try {
        const resolution = await resolver.resolveTrustedOwners(rootOwner.globalMetaId);
        return commandSuccess({
          owner: rootOwner.globalMetaId,
          trustedOwners: resolution.trustedOwners,
          fromCache: resolution.fromCache,
        });
      } catch (error) {
        return trustFailure(error, 'trust_list_failed');
      }
    },

    grant: async (rawInput) => {
      const rootOwner = await requireRootOwner();
      if (!('mnemonic' in rootOwner)) return rootOwner;
      const trustedOwner = normalizeGlobalMetaId(normalizeText(rawInput?.trustedOwner));
      if (!trustedOwner) {
        return commandFailed('invalid_trusted_owner', 'trustedOwner must be a valid GlobalMetaID.');
      }
      const signer = resolveSigner(rootOwner);
      if (!signer) {
        return commandFailed('chain_unavailable', 'Chain publish is not configured in this daemon.');
      }
      const note = normalizeText(rawInput?.note) || undefined;
      try {
        const result = await publishTrustGrant({
          owner: rootOwner,
          trustedOwner,
          note,
          signer,
          ...(input.requestSubsidy ? { requestSubsidy: input.requestSubsidy } : {}),
        });
        // The owner's own grants changed — drop the stale cache entry.
        await resolver.invalidate(rootOwner.globalMetaId);
        return commandSuccess({
          trustGrant: {
            owner: rootOwner.globalMetaId,
            trustedOwner,
            note: note ?? null,
            path: '/protocols/simpletrust',
            pinId: result.chainWrite.pinId,
          },
          subsidy: result.subsidy,
          chainWrites: [result.chainWrite],
        });
      } catch (error) {
        return trustFailure(error, 'trust_grant_failed');
      }
    },

    revoke: async (rawInput) => {
      const rootOwner = await requireRootOwner();
      if (!('mnemonic' in rootOwner)) return rootOwner;
      const target = normalizeText(rawInput?.target);
      if (!target) {
        return commandFailed('missing_revoke_target', 'target (owner GlobalMetaID or grant pinId) is required.');
      }
      const signer = resolveSigner(rootOwner);
      if (!signer) {
        return commandFailed('chain_unavailable', 'Chain publish is not configured in this daemon.');
      }
      try {
        // A gmid target revokes every effective grant to that owner; a pinId
        // target revokes exactly the grant it names.
        const revokePinIds: string[] = [];
        if (normalizeGlobalMetaId(target)) {
          const resolution = await resolver.resolveTrustedOwners(rootOwner.globalMetaId);
          const matching = resolution.trustedOwners.filter((grant) => grant.trustedOwner === normalizeGlobalMetaId(target));
          if (matching.length === 0) {
            return commandFailed(
              'trust_grant_not_found',
              `No effective trust grant to ${target}. Nothing to revoke.`,
            );
          }
          revokePinIds.push(...matching.map((grant) => grant.grantPinId));
        } else if (looksLikeGrantPinId(target)) {
          revokePinIds.push(target);
        } else {
          return commandFailed(
            'invalid_revoke_target',
            'target must be an owner GlobalMetaID or a grant pinId (<txid>i<n>).',
          );
        }

        const chainWrites = [];
        for (const revoke of revokePinIds) {
          const result = await publishTrustRevoke({
            owner: rootOwner,
            revoke,
            signer,
            ...(input.requestSubsidy ? { requestSubsidy: input.requestSubsidy } : {}),
          });
          chainWrites.push(result.chainWrite);
        }
        await resolver.invalidate(rootOwner.globalMetaId);
        return commandSuccess({
          revoked: revokePinIds,
          owner: rootOwner.globalMetaId,
          chainWrites,
        });
      } catch (error) {
        return trustFailure(error, 'trust_revoke_failed');
      }
    },
  };
}
