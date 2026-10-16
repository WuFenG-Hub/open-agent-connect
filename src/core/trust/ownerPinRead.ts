// Chain read for /info/owner pins: resolves the LATEST binding pin at
// /info/owner for an arbitrary subject GlobalMetaID. Built on the same
// public MANAPI endpoints the rest of the codebase reads (the
// `lookupPeerChatPublicKey` / `manOwnerList` / omni-read conventions):
//   1. GET /api/info/metaid/:globalMetaId  -> the subject's MVC address
//   2. GET /api/address/pin/list/:address?path=/info/owner -> newest pin row
//   3. GET /content/:pinId                 -> full (untruncated) payload
// `contentSummary` in list rows is a truncated JSON preview, so the payload
// is always re-fetched by pinId. All reads are read-only HTTP GETs.
import { OWNER_BINDING_PATH } from '../owner/ownerBinding';

export const DEFAULT_OWNER_PIN_MANAPI_BASE_URL = 'https://manapi.metaid.io';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_SIZE = 20;

export interface LatestOwnerPin {
  pinId: string;
  /** Full pin payload string; null when the pin body is empty (unbound). */
  payload: string | null;
}

/** Injectable read seam: latest /info/owner pin for a subject GlobalMetaID, or null. */
export type OwnerPinReader = (globalMetaId: string) => Promise<LatestOwnerPin | null>;

export interface OwnerPinReadOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ResolvedOwnerPinReadOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

function resolveOptions(options: OwnerPinReadOptions | undefined): ResolvedOwnerPinReadOptions {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for owner pin reads.');
  }
  return {
    baseUrl: (options?.baseUrl ?? DEFAULT_OWNER_PIN_MANAPI_BASE_URL).replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function fetchJson(url: string, options: ResolvedOwnerPinReadOptions): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return readObject(await response.json().catch(() => null));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Step 1: the subject's on-chain info record; the address drives the per-author pin list. */
export async function resolveMetaIdOwnerAddress(
  globalMetaId: string,
  options?: OwnerPinReadOptions,
): Promise<string | null> {
  const resolved = resolveOptions(options);
  const normalized = text(globalMetaId).toLowerCase();
  if (!normalized) return null;
  const body = await fetchJson(
    `${resolved.baseUrl}/api/info/metaid/${encodeURIComponent(normalized)}`,
    resolved,
  );
  const data = readObject(body?.data) ?? body ?? {};
  return text(data.address) || null;
}

export interface AuthorPinListRow {
  pinId: string;
  operation: string;
  timestamp: number;
  path: string;
  globalMetaId: string;
}

function normalizeListRow(raw: unknown): AuthorPinListRow | null {
  const record = readObject(raw);
  if (!record) return null;
  const pinId = text(record.id ?? record.pinId ?? record.pin_id);
  if (!pinId) return null;
  return {
    pinId,
    operation: text(record.operation).toLowerCase(),
    timestamp: Number(record.timestamp) || 0,
    path: text(record.path),
    globalMetaId: text(record.globalMetaId ?? record.global_meta_id),
  };
}

/**
 * Step 2: the effective (latest, non-revoked) pin row the subject published
 * at `path`, newest first. Revoked rows mean "unbound" and are skipped;
 * malformed envelopes yield null instead of throwing (a read failure makes
 * the caller treat the subject as unbound — the conservative direction).
 */
export async function listLatestAuthorPin(
  address: string,
  path: string,
  options?: OwnerPinReadOptions,
): Promise<AuthorPinListRow | null> {
  const resolved = resolveOptions(options);
  const normalizedAddress = text(address);
  const normalizedPath = text(path);
  if (!normalizedAddress || !normalizedPath) return null;
  const url = new URL(`${resolved.baseUrl}/api/address/pin/list/${encodeURIComponent(normalizedAddress)}`);
  url.searchParams.set('path', normalizedPath);
  url.searchParams.set('size', String(DEFAULT_LIST_SIZE));
  const body = await fetchJson(url.toString(), resolved);
  if (!body) return null;
  const data = readObject(body.data);
  if (!data || Number(body.code) !== 1) return null;
  const rows = (Array.isArray(data.list) ? data.list : [])
    .map(normalizeListRow)
    .filter((row): row is AuthorPinListRow => row !== null && row.path === normalizedPath)
    .filter((row) => row.operation !== 'revoke' && row.operation !== 'delete' && row.operation !== 'deleted');
  if (rows.length === 0) return null;
  rows.sort((a, b) => (b.timestamp - a.timestamp) || a.pinId.localeCompare(b.pinId));
  return rows[0];
}

/** Step 3: the full pin body; an empty body means unbound (payload null). */
export async function fetchOwnerPinContent(
  pinId: string,
  options?: OwnerPinReadOptions,
): Promise<string | null> {
  const resolved = resolveOptions(options);
  const normalized = text(pinId);
  if (!normalized) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  try {
    const response = await resolved.fetchImpl(`${resolved.baseUrl}/content/${encodeURIComponent(normalized)}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.text();
    return body.trim() ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default OwnerPinReader: address -> latest /info/owner row -> full payload.
 * Any failed/empty step yields null (treated as "no verifiable binding").
 */
export function createOwnerPinReader(options?: OwnerPinReadOptions): OwnerPinReader {
  return async (globalMetaId: string): Promise<LatestOwnerPin | null> => {
    const address = await resolveMetaIdOwnerAddress(globalMetaId, options);
    if (!address) return null;
    const row = await listLatestAuthorPin(address, OWNER_BINDING_PATH, options);
    if (!row) return null;
    const payload = await fetchOwnerPinContent(row.pinId, options);
    return { pinId: row.pinId, payload };
  };
}
