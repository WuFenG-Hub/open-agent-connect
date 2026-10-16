// Team registry (trust tiers P4b/P5): the machine-wide list of REMOTE team
// Bot gmids — Bots on other devices bound to the same root owner. Entries are
// recorded manually via `metabot team add` (verified same root owner on-chain
// before recording, source 'manual') or auto-recorded by the peer tier
// resolver when a peer resolves to the 'team' tier (source 'auto'). The file
// is OPTIONAL: absence, a corrupt file, or junk rows all read as an empty
// registry — every consumer must still verify tier at the point of use
// (createGroupTask enforces tier 'team').
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { resolveMetabotOwnerPaths } from '../state/paths';

const TEAM_REGISTRY_FILE_MODE = 0o600;

export type TeamRegistrySource = 'manual' | 'auto';

export interface TeamRegistryEntry {
  globalMetaId: string;
  source: TeamRegistrySource;
  addedAt?: string;
  note?: string;
}

function normalizeSource(value: unknown): TeamRegistrySource {
  return value === 'auto' ? 'auto' : 'manual';
}

function normalizeEntries(value: unknown): TeamRegistryEntry[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).teamBots
      : null;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: TeamRegistryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const globalMetaId = normalizeGlobalMetaId(record.globalMetaId);
    if (!globalMetaId || seen.has(globalMetaId)) continue;
    seen.add(globalMetaId);
    const entry: TeamRegistryEntry = { globalMetaId, source: normalizeSource(record.source) };
    const addedAt = typeof record.addedAt === 'string' && record.addedAt.trim() ? record.addedAt.trim() : '';
    if (addedAt) entry.addedAt = addedAt;
    const note = typeof record.note === 'string' && record.note.trim() ? record.note.trim() : '';
    if (note) entry.note = note;
    entries.push(entry);
  }
  return entries;
}

async function applyTeamRegistryFileMode(filePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await fs.chmod(filePath, TEAM_REGISTRY_FILE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL') return;
    throw error;
  }
}

async function writeRegistryFile(filePath: string, entries: TeamRegistryEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify({ version: 1, teamBots: entries }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: TEAM_REGISTRY_FILE_MODE,
    });
    await fs.rename(tempPath, filePath);
    await applyTeamRegistryFileMode(filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export interface TeamRegistryStore {
  list(): Promise<TeamRegistryEntry[]>;
  /** Insert or replace one entry (matched by gmid, normalized). */
  upsert(entry: TeamRegistryEntry): Promise<TeamRegistryEntry[]>;
  /** Drop one entry; a no-op when absent. */
  remove(globalMetaId: string): Promise<TeamRegistryEntry[]>;
}

export function createTeamRegistryStore(systemHomeDir: string): TeamRegistryStore {
  const filePath = resolveMetabotOwnerPaths(systemHomeDir).teamRegistryPath;
  async function readEntries(): Promise<TeamRegistryEntry[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      // Absent or corrupt: the registry is optional.
      return [];
    }
    return normalizeEntries(raw);
  }
  return {
    async list() {
      return readEntries();
    },
    async upsert(entry) {
      const normalized = normalizeGlobalMetaId(entry.globalMetaId);
      if (!normalized) throw new Error(`Invalid GlobalMetaID: ${String(entry.globalMetaId)}`);
      const entries = await readEntries();
      const nextEntry: TeamRegistryEntry = { ...entry, globalMetaId: normalized };
      const index = entries.findIndex((existing) => existing.globalMetaId === normalized);
      if (index >= 0) {
        // Preserve the original addedAt unless the new entry carries one.
        nextEntry.addedAt = nextEntry.addedAt ?? entries[index].addedAt;
        entries[index] = nextEntry;
      } else {
        entries.push(nextEntry);
      }
      await writeRegistryFile(filePath, entries);
      return entries;
    },
    async remove(globalMetaId) {
      const normalized = normalizeGlobalMetaId(globalMetaId);
      if (!normalized) throw new Error(`Invalid GlobalMetaID: ${String(globalMetaId)}`);
      const entries = await readEntries();
      const next = entries.filter((entry) => entry.globalMetaId !== normalized);
      if (next.length !== entries.length) {
        await writeRegistryFile(filePath, next);
      }
      return next;
    },
  };
}

/** Remote team Bot gmids recorded on this machine (empty when none/unreadable). */
export async function listTeamRegistryGmids(systemHomeDir: string): Promise<string[]> {
  return (await createTeamRegistryStore(systemHomeDir).list()).map((entry) => entry.globalMetaId);
}
