// Local trust store (trust tiers P2, M1): the device-level blocklist and
// the explicit human-approved contacts, stored machine-wide at
// `~/.metabot/owner/trust-local.json` (storage-layout v2 amendment
// 2026-10-16). Blocked gmids silence a peer for EVERY local Bot; contacts
// are peers a human explicitly approved (e.g. an approved stranger invite).
// On-chain `simpleblock` replaces/merges this in M2.
//
// Atomic write-then-rename, 0600, lazily materialized, defensive reads.
// `blockGmid`/`unblockGmid` compose the store with the trust cache: a block
// change drops the subject's cached binding resolution so the next tier
// check (P3) cannot serve stale state for the newly blocked peer.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { resolveMetabotOwnerPaths } from '../state/paths';
import { createTrustCacheStore } from './trustCacheStore';

const TRUST_LOCAL_FILE_MODE = 0o600;

export interface TrustLocalState {
  blocked: string[];
  contacts: string[];
}

export interface TrustLocalStore {
  read(): Promise<TrustLocalState>;
  setBlocked(globalMetaId: string, blocked: boolean): Promise<TrustLocalState>;
  setContact(globalMetaId: string, contact: boolean): Promise<TrustLocalState>;
}

function normalizeGmidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = normalizeGlobalMetaId(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeTrustLocalState(value: unknown): TrustLocalState {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    blocked: normalizeGmidList(record.blocked),
    contacts: normalizeGmidList(record.contacts),
  };
}

async function applyTrustLocalFileMode(filePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await fs.chmod(filePath, TRUST_LOCAL_FILE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL') return;
    throw error;
  }
}

async function writeTrustLocalFile(filePath: string, state: TrustLocalState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: TRUST_LOCAL_FILE_MODE,
    });
    await fs.rename(tempPath, filePath);
    await applyTrustLocalFileMode(filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export function createTrustLocalStore(systemHomeDir: string): TrustLocalStore {
  const filePath = resolveMetabotOwnerPaths(systemHomeDir).trustLocalPath;
  return {
    async read() {
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { blocked: [], contacts: [] };
        // A corrupt local store must never break chat ingress — start empty.
        return { blocked: [], contacts: [] };
      }
      return normalizeTrustLocalState(raw);
    },
    async setBlocked(globalMetaId, blocked) {
      const normalized = normalizeGlobalMetaId(globalMetaId);
      if (!normalized) throw new Error(`Invalid GlobalMetaID: ${String(globalMetaId)}`);
      const state = await this.read();
      const next: TrustLocalState = {
        ...state,
        blocked: blocked
          ? [...state.blocked.filter((g) => g !== normalized), normalized]
          : state.blocked.filter((g) => g !== normalized),
      };
      await writeTrustLocalFile(filePath, next);
      return next;
    },
    async setContact(globalMetaId, contact) {
      const normalized = normalizeGlobalMetaId(globalMetaId);
      if (!normalized) throw new Error(`Invalid GlobalMetaID: ${String(globalMetaId)}`);
      const state = await this.read();
      const next: TrustLocalState = {
        ...state,
        contacts: contact
          ? [...state.contacts.filter((g) => g !== normalized), normalized]
          : state.contacts.filter((g) => g !== normalized),
      };
      await writeTrustLocalFile(filePath, next);
      return next;
    },
  };
}

/**
 * Block a peer device-wide AND drop its cached trust resolution, so the next
 * tier check re-resolves instead of serving stale state. Unblocking likewise
 * clears the cache entry.
 */
export async function blockGmid(systemHomeDir: string, globalMetaId: string): Promise<TrustLocalState> {
  const state = await createTrustLocalStore(systemHomeDir).setBlocked(globalMetaId, true);
  await createTrustCacheStore(systemHomeDir).invalidate(globalMetaId);
  return state;
}

export async function unblockGmid(systemHomeDir: string, globalMetaId: string): Promise<TrustLocalState> {
  const state = await createTrustLocalStore(systemHomeDir).setBlocked(globalMetaId, false);
  await createTrustCacheStore(systemHomeDir).invalidate(globalMetaId);
  return state;
}

export async function listBlockedGmids(systemHomeDir: string): Promise<string[]> {
  return (await createTrustLocalStore(systemHomeDir).read()).blocked;
}

export async function isBlockedGmid(systemHomeDir: string, globalMetaId: string): Promise<boolean> {
  const normalized = normalizeGlobalMetaId(globalMetaId);
  if (!normalized) return false;
  return (await listBlockedGmids(systemHomeDir)).includes(normalized);
}
