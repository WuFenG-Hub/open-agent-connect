// Team registry (trust tiers P4b): the machine-wide list of REMOTE team Bot
// gmids — Bots on other devices bound to the same root owner. Populated by
// the P5 `metabot team add` flow (which verifies the root owner on-chain
// before recording); read here as *candidates* for group-task team seating
// and staffing slates. The file is OPTIONAL: absence, a corrupt file, or
// junk rows all read as an empty registry — every consumer must still
// verify tier at the point of use (createGroupTask enforces tier 'team').
import { promises as fs } from 'node:fs';
import { normalizeGlobalMetaId } from '../identity/deriveIdentity';
import { resolveMetabotOwnerPaths } from '../state/paths';

export interface TeamRegistryEntry {
  globalMetaId: string;
  note?: string;
  addedAt?: string;
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
    const note = typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined;
    const addedAt = typeof record.addedAt === 'string' && record.addedAt.trim() ? record.addedAt.trim() : undefined;
    entries.push(note || addedAt ? { globalMetaId, ...(note ? { note } : {}), ...(addedAt ? { addedAt } : {}) } : { globalMetaId });
  }
  return entries;
}

export interface TeamRegistryStore {
  list(): Promise<TeamRegistryEntry[]>;
}

export function createTeamRegistryStore(systemHomeDir: string): TeamRegistryStore {
  const filePath = resolveMetabotOwnerPaths(systemHomeDir).teamRegistryPath;
  return {
    async list() {
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch {
        // Absent or corrupt: the registry is optional in P4b.
        return [];
      }
      return normalizeEntries(raw);
    },
  };
}

/** Remote team Bot gmids recorded on this machine (empty when none/unreadable). */
export async function listTeamRegistryGmids(systemHomeDir: string): Promise<string[]> {
  return (await createTeamRegistryStore(systemHomeDir).list()).map((entry) => entry.globalMetaId);
}
