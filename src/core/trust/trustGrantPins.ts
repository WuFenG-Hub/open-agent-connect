// On-chain owner trust grants (`/protocols/simpletrust`, trust tiers P2):
// an Owner MetaID publishes append-only pins declaring which OTHER owners it
// trusts. Grants are self-authenticating — the pin's on-chain signature by
// the owner key IS the consent; no grantee signature is required (trust is
// a unilateral decision of the granting side).
//
// Wire format (docs/metaid_protocols/09-simpletrust.md):
//   grant:  { "version": 1, "trustedOwner": "idq1…", "note": "…", "ts": 1730000000 }
//   revoke: { "version": 1, "revoke": "<grantPinId>", "ts": 1730000000 }
// Revoke mechanics mirror the established in-repo conventions: like
// simpleblock (04-chat-messaging.md) the history is append-only and the
// latest state is derived by folding the whole pin set, and like
// metatask/metaapp amendments a revoke REFERENCES its target — here the
// exact grant pinId, so a revoke only ever cancels the grant it names.
// Effective trust set = grants minus revokes (per pinId), deduped per
// trustedOwner with the newest grant winning. A revoke naming an unknown
// pinId is a no-op; it is still published (append-only audit trail).
import type { ChainWriteRequest, ChainWriteResult } from '../chain/writePin';
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { IdentityPinPublishError, publishIdentityPin, type IdentityPinSubsidyOutcome } from '../owner/identityChainPublisher';
import type { OwnerIdentityRecord } from '../owner/ownerIdentity';
import type { RequestMvcGasSubsidyOptions, RequestMvcGasSubsidyResult } from '../subsidy/requestMvcGasSubsidy';
import type { Signer } from '../signing/signer';

export const SIMPLETRUST_PATH = '/protocols/simpletrust';
export const SIMPLETRUST_VERSION = 1;

export class TrustGrantError extends Error {
  constructor(
    readonly code: 'invalid_trusted_owner' | 'invalid_revoke_target',
    message: string,
  ) {
    super(message);
    this.name = 'TrustGrantError';
  }
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

export type ParsedSimpletrustPin =
  | { kind: 'grant'; trustedOwner: string; note?: string; ts: number }
  | { kind: 'revoke'; revoke: string; ts: number };

export function buildTrustGrantPayload(input: { trustedOwner: string; note?: string; ts: number }): string {
  const trustedOwner = normalizeGlobalMetaId(input.trustedOwner);
  if (!trustedOwner) {
    throw new TrustGrantError('invalid_trusted_owner', `trustedOwner is not a valid GlobalMetaID: ${String(input.trustedOwner)}`);
  }
  const payload: TrustGrantPayload = { version: SIMPLETRUST_VERSION, trustedOwner, ts: Math.floor(input.ts) };
  const note = (input.note ?? '').trim();
  if (note) payload.note = note;
  return JSON.stringify(payload);
}

export function buildTrustRevokePayload(input: { revoke: string; ts: number }): string {
  const revoke = (input.revoke ?? '').trim();
  if (!revoke) {
    throw new TrustGrantError('invalid_revoke_target', 'revoke must name the grant pinId to cancel.');
  }
  const payload: TrustRevokePayload = { version: SIMPLETRUST_VERSION, revoke, ts: Math.floor(input.ts) };
  return JSON.stringify(payload);
}

/** Lenient parser: returns null for anything that is not a well-formed simpletrust pin. */
export function parseSimpletrustPin(raw: string | null | undefined): ParsedSimpletrustPin | null {
  if (!raw || typeof raw !== 'string') return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.version !== SIMPLETRUST_VERSION) return null;
  const ts = Number(parsed.ts);
  if (!Number.isFinite(ts)) return null;
  const revoke = typeof parsed.revoke === 'string' ? parsed.revoke.trim() : '';
  if (revoke) {
    return { kind: 'revoke', revoke, ts: Math.floor(ts) };
  }
  const trustedOwner = normalizeGlobalMetaId(parsed.trustedOwner);
  if (!trustedOwner) return null;
  const note = typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : undefined;
  return note ? { kind: 'grant', trustedOwner, note, ts: Math.floor(ts) } : { kind: 'grant', trustedOwner, ts: Math.floor(ts) };
}

function buildSimpletrustWrite(payload: string): ChainWriteRequest {
  return {
    operation: 'create',
    path: SIMPLETRUST_PATH,
    contentType: 'application/json',
    payload,
    encoding: 'utf-8',
    encryption: '0',
    version: '1.0',
    network: 'mvc',
  };
}

export interface PublishTrustGrantResult {
  payload: string;
  chainWrite: ChainWriteResult;
  subsidy: IdentityPinSubsidyOutcome;
}

/** Publish one trust grant pin from the owner identity (`signer` = owner signer). */
export async function publishTrustGrant(input: {
  owner: Pick<OwnerIdentityRecord, 'mvcAddress' | 'mnemonic' | 'path'>;
  trustedOwner: string;
  note?: string;
  ts?: number;
  signer: Signer;
  requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishTrustGrantResult> {
  const payload = buildTrustGrantPayload({
    trustedOwner: input.trustedOwner,
    note: input.note,
    ts: input.ts ?? Date.now() / 1000,
  });
  const { chainWrite, subsidy } = await publishIdentityPin({
    identity: input.owner,
    signer: input.signer,
    requestSubsidy: input.requestSubsidy,
    request: buildSimpletrustWrite(payload),
  });
  return { payload, chainWrite, subsidy };
}

/** Publish one revoke pin cancelling the grant named by `revoke` (a grant pinId). */
export async function publishTrustRevoke(input: {
  owner: Pick<OwnerIdentityRecord, 'mvcAddress' | 'mnemonic' | 'path'>;
  revoke: string;
  ts?: number;
  signer: Signer;
  requestSubsidy?: (options: RequestMvcGasSubsidyOptions) => Promise<RequestMvcGasSubsidyResult>;
}): Promise<PublishTrustGrantResult> {
  const payload = buildTrustRevokePayload({ revoke: input.revoke, ts: input.ts ?? Date.now() / 1000 });
  const { chainWrite, subsidy } = await publishIdentityPin({
    identity: input.owner,
    signer: input.signer,
    requestSubsidy: input.requestSubsidy,
    request: buildSimpletrustWrite(payload),
  });
  return { payload, chainWrite, subsidy };
}
