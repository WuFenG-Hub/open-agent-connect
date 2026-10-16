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
}

export interface TrustCacheStore {
  get(subjectGlobalMetaId: string): Promise<TrustCacheEntry | null>;
  set(entry: TrustCacheEntry): Promise<void>;
  /** Drop one subject (e.g. right after its binding pin was re-published). */
  invalidate(subjectGlobalMetaId: string): Promise<void>;
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

async function readCacheFile(filePath: string): Promise<Record<string, TrustCacheEntry>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // A corrupt cache must never break resolution — re-resolve from chain.
    return {};
  }
  if (!isRecord(raw) || !isRecord(raw.entries)) return {};
  const entries: Record<string, TrustCacheEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    const entry = normalizeEntry(key, value);
    if (entry) entries[entry.subjectGlobalMetaId] = entry;
  }
  return entries;
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

async function writeCacheFile(filePath: string, entries: Record<string, TrustCacheEntry>): Promise<void> {
  const payload: TrustCacheFile = { version: 1, entries };
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
      return (await readCacheFile(filePath))[normalized] ?? null;
    },
    async set(entry) {
      const normalized = normalizeGlobalMetaId(entry.subjectGlobalMetaId);
      if (!normalized) return;
      const entries = await readCacheFile(filePath);
      entries[normalized] = { ...entry, subjectGlobalMetaId: normalized };
      await writeCacheFile(filePath, entries);
    },
    async invalidate(subjectGlobalMetaId) {
      const normalized = normalizeGlobalMetaId(subjectGlobalMetaId);
      if (!normalized) return;
      const entries = await readCacheFile(filePath);
      if (!(normalized in entries)) return;
      delete entries[normalized];
      await writeCacheFile(filePath, entries);
    },
    async clear() {
      await writeCacheFile(filePath, {});
    },
  };
}
