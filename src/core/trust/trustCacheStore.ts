// Trust cache: resolved /info/owner chains keyed by subject GlobalMetaID,
// stored machine-wide at `~/.metabot/owner/trust-cache.json` (storage-layout
// v2 amendment 2026-10-16). Each entry records the pinId its resolution is
// based on, so an entry is stale exactly when a newer binding pin lands; the
// resolver additionally bounds staleness with a TTL and exposes explicit
// per-subject invalidation. Atomic write-then-rename, 0600, lazily
// materialized, defensive normalization on read.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { resolveMetabotOwnerPaths } from '../state/paths';

const TRUST_CACHE_FILE_MODE = 0o600;

export interface TrustChainLink {
  /** The identity that published the /info/owner pin. */
  subjectGmid: string;
  /** The identity the payload binds as directly accountable for the subject. */
  ownerGmid: string;
  /** The pinId whose payload was verified. */
  pinId: string;
}

export interface TrustCacheEntry {
  subjectGlobalMetaId: string;
  /** Latest /info/owner pinId this resolution is based on; null = subject had no binding pin. */
  pinId: string | null;
  /** Terminal verified gmid of the walk (the root owner; may equal the subject). */
  rootOwnerGlobalMetaId: string;
  /** Verified links starting at this subject. */
  chain: TrustChainLink[];
  /** ISO timestamp of the resolution. */
  resolvedAt: string;
}

interface TrustCacheFile {
  version: 1;
  entries: Record<string, TrustCacheEntry>;
  /**
   * P2 addition: resolved /protocols/simpletrust grant sets keyed by the
   * GRANTING owner's GlobalMetaID. Absent in P1-written files — normalized
   * to {} on read.
   */
  grants?: Record<string, TrustGrantCacheEntry>;
}

/** One effective trust grant after the grants-minus-revokes fold. */
export interface ResolvedTrustGrant {
  trustedOwner: string;
  note?: string;
  /** Unix seconds from the grant payload. */
  ts: number;
  /** The grant pinId (what a revoke pin references). */
  grantPinId: string;
}

export interface TrustGrantCacheEntry {
  ownerGlobalMetaId: string;
  /** Newest simpletrust pinId this resolution is based on; null = owner has no pins. */
  pinId: string | null;
  trustedOwners: ResolvedTrustGrant[];
  /** ISO timestamp of the resolution. */
  resolvedAt: string;
}

export interface TrustCacheStore {
  get(subjectGlobalMetaId: string): Promise<TrustCacheEntry | null>;
  set(entry: TrustCacheEntry): Promise<void>;
  /** Drop one subject (e.g. right after its binding pin was re-published). */
  invalidate(subjectGlobalMetaId: string): Promise<void>;
  getGrants(ownerGlobalMetaId: string): Promise<TrustGrantCacheEntry | null>;
  setGrants(entry: TrustGrantCacheEntry): Promise<void>;
  /** Drop one owner's grant resolution (right after publishing a grant/revoke). */
  invalidateGrants(ownerGlobalMetaId: string): Promise<void>;
  clear(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeChainLink(value: unknown): TrustChainLink | null {
  if (!isRecord(value)) return null;
  const subjectGmid = normalizeGlobalMetaId(value.subjectGmid);
  const ownerGmid = normalizeGlobalMetaId(value.ownerGmid);
  const pinId = typeof value.pinId === 'string' ? value.pinId.trim() : '';
  if (!subjectGmid || !ownerGmid || !pinId) return null;
  return { subjectGmid, ownerGmid, pinId };
}

function normalizeEntry(subjectKey: string, value: unknown): TrustCacheEntry | null {
  if (!isRecord(value)) return null;
  const subjectGlobalMetaId = normalizeGlobalMetaId(value.subjectGlobalMetaId) ?? normalizeGlobalMetaId(subjectKey);
  const rootOwnerGlobalMetaId = normalizeGlobalMetaId(value.rootOwnerGlobalMetaId);
  if (!subjectGlobalMetaId || !rootOwnerGlobalMetaId) return null;
  const chain = Array.isArray(value.chain)
    ? value.chain.map(normalizeChainLink).filter((link): link is TrustChainLink => link !== null)
    : [];
  const pinId = value.pinId === null || value.pinId === undefined
    ? null
    : typeof value.pinId === 'string' && value.pinId.trim()
      ? value.pinId.trim()
      : null;
  const resolvedAt = typeof value.resolvedAt === 'string' && value.resolvedAt.trim()
    ? value.resolvedAt
    : new Date(0).toISOString();
  return { subjectGlobalMetaId, pinId, rootOwnerGlobalMetaId, chain, resolvedAt };
}

function normalizeGrant(value: unknown): ResolvedTrustGrant | null {
  if (!isRecord(value)) return null;
  const trustedOwner = normalizeGlobalMetaId(value.trustedOwner);
  const grantPinId = typeof value.grantPinId === 'string' ? value.grantPinId.trim() : '';
  const ts = Number(value.ts);
  if (!trustedOwner || !grantPinId || !Number.isFinite(ts)) return null;
  const note = typeof value.note === 'string' && value.note.trim() ? value.note.trim() : undefined;
  return note ? { trustedOwner, note, ts, grantPinId } : { trustedOwner, ts, grantPinId };
}

function normalizeGrantEntry(ownerKey: string, value: unknown): TrustGrantCacheEntry | null {
  if (!isRecord(value)) return null;
  const ownerGlobalMetaId = normalizeGlobalMetaId(value.ownerGlobalMetaId) ?? normalizeGlobalMetaId(ownerKey);
  if (!ownerGlobalMetaId) return null;
  const trustedOwners = Array.isArray(value.trustedOwners)
    ? value.trustedOwners.map(normalizeGrant).filter((grant): grant is ResolvedTrustGrant => grant !== null)
    : [];
  const pinId = value.pinId === null || value.pinId === undefined
    ? null
    : typeof value.pinId === 'string' && value.pinId.trim()
      ? value.pinId.trim()
      : null;
  const resolvedAt = typeof value.resolvedAt === 'string' && value.resolvedAt.trim()
    ? value.resolvedAt
    : new Date(0).toISOString();
  return { ownerGlobalMetaId, pinId, trustedOwners, resolvedAt };
}

interface TrustCacheFileData {
  entries: Record<string, TrustCacheEntry>;
  grants: Record<string, TrustGrantCacheEntry>;
}

async function readCacheFile(filePath: string): Promise<TrustCacheFileData> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: {}, grants: {} };
    // A corrupt cache must never break resolution — re-resolve from chain.
    return { entries: {}, grants: {} };
  }
  if (!isRecord(raw) || !isRecord(raw.entries)) return { entries: {}, grants: {} };
  const entries: Record<string, TrustCacheEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    const entry = normalizeEntry(key, value);
    if (entry) entries[entry.subjectGlobalMetaId] = entry;
  }
  const grants: Record<string, TrustGrantCacheEntry> = {};
  if (isRecord(raw.grants)) {
    for (const [key, value] of Object.entries(raw.grants)) {
      const grant = normalizeGrantEntry(key, value);
      if (grant) grants[grant.ownerGlobalMetaId] = grant;
    }
  }
  return { entries, grants };
}

async function applyTrustCacheFileMode(filePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await fs.chmod(filePath, TRUST_CACHE_FILE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL') return;
    throw error;
  }
}

async function writeCacheFile(filePath: string, data: TrustCacheFileData): Promise<void> {
  const payload: TrustCacheFile = { version: 1, entries: data.entries, grants: data.grants };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: TRUST_CACHE_FILE_MODE,
    });
    await fs.rename(tempPath, filePath);
    await applyTrustCacheFileMode(filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export function createTrustCacheStore(systemHomeDir: string): TrustCacheStore {
  const filePath = resolveMetabotOwnerPaths(systemHomeDir).trustCachePath;
  return {
    async get(subjectGlobalMetaId) {
      const normalized = normalizeGlobalMetaId(subjectGlobalMetaId);
      if (!normalized) return null;
      return (await readCacheFile(filePath)).entries[normalized] ?? null;
    },
    async set(entry) {
      const normalized = normalizeGlobalMetaId(entry.subjectGlobalMetaId);
      if (!normalized) return;
      const data = await readCacheFile(filePath);
      data.entries[normalized] = { ...entry, subjectGlobalMetaId: normalized };
      await writeCacheFile(filePath, data);
    },
    async invalidate(subjectGlobalMetaId) {
      const normalized = normalizeGlobalMetaId(subjectGlobalMetaId);
      if (!normalized) return;
      const data = await readCacheFile(filePath);
      if (!(normalized in data.entries)) return;
      delete data.entries[normalized];
      await writeCacheFile(filePath, data);
    },
    async getGrants(ownerGlobalMetaId) {
      const normalized = normalizeGlobalMetaId(ownerGlobalMetaId);
      if (!normalized) return null;
      return (await readCacheFile(filePath)).grants[normalized] ?? null;
    },
    async setGrants(entry) {
      const normalized = normalizeGlobalMetaId(entry.ownerGlobalMetaId);
      if (!normalized) return;
      const data = await readCacheFile(filePath);
      data.grants[normalized] = { ...entry, ownerGlobalMetaId: normalized };
      await writeCacheFile(filePath, data);
    },
    async invalidateGrants(ownerGlobalMetaId) {
      const normalized = normalizeGlobalMetaId(ownerGlobalMetaId);
      if (!normalized) return;
      const data = await readCacheFile(filePath);
      if (!(normalized in data.grants)) return;
      delete data.grants[normalized];
      await writeCacheFile(filePath, data);
    },
    async clear() {
      await writeCacheFile(filePath, { entries: {}, grants: {} });
    },
  };
}
