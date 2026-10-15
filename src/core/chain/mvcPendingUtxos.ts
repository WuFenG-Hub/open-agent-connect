import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChainUtxo } from './adapters/types';

export const MVC_PENDING_UTXO_TTL_MS = 10 * 60 * 1000;

interface PendingSpentOutpoint {
  expiresAt: number;
}

interface PendingAvailableUtxo {
  utxo: ChainUtxo;
  expiresAt: number;
}

/** Maps address:txid:outputIndex to pending spent outpoint state. */
const pendingSpentOutpoints = new Map<string, PendingSpentOutpoint>();
const pendingAvailableUtxos = new Map<string, PendingAvailableUtxo>();

/**
 * Optional cross-process journal (best-effort, sync + atomic rename). The
 * in-memory maps die with the process, but explorer UTXO views lag several
 * seconds behind a broadcast — a CLI transfer followed by a daemon-side
 * upload would otherwise rebuild from already-spent outpoints and hit
 * txn-mempool-conflict. Wire-up: configurePendingMvcUtxoPersistence at
 * process start (daemon serve + CLI runtime); unit tests stay hermetic by
 * leaving it unconfigured.
 */
let persistentJournalPath: string | null = null;
interface PersistedPendingUtxoJournal {
  spent: Record<string, number>;
  available: Record<string, { utxo: ChainUtxo; expiresAt: number }>;
}
let journalSnapshot: { mtimeMs: number; journal: PersistedPendingUtxoJournal } | null = null;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOutpointTxid(value: string): string {
  return normalizeText(value).toLowerCase();
}

export function getMvcUtxoOutpointKey(input: {
  txId: string;
  outputIndex: number;
  address?: string;
}): string {
  const outpointParts = [normalizeOutpointTxid(input.txId), String(input.outputIndex)];
  if (Object.hasOwn(input, 'address')) {
    return [normalizeText(input.address), ...outpointParts].join(':');
  }
  return outpointParts.join(':');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function configurePendingMvcUtxoPersistence(input: { journalPath: string }): void {
  const normalized = normalizeText(input.journalPath);
  persistentJournalPath = normalized || null;
  journalSnapshot = null;
}

function readPersistedJournal(now: number): PersistedPendingUtxoJournal {
  if (!persistentJournalPath) {
    return { spent: {}, available: {} };
  }
  try {
    const mtimeMs = statSync(persistentJournalPath).mtimeMs;
    if (journalSnapshot && journalSnapshot.mtimeMs === mtimeMs) {
      return journalSnapshot.journal;
    }
    const parsed: unknown = JSON.parse(readFileSync(persistentJournalPath, 'utf8'));
    const spent: Record<string, number> = {};
    const available: PersistedPendingUtxoJournal['available'] = {};
    if (isPlainObject(parsed)) {
      const parsedSpent = parsed.spent;
      if (isPlainObject(parsedSpent)) {
        for (const [key, value] of Object.entries(parsedSpent)) {
          if (typeof value === 'number' && value > now) spent[key] = value;
        }
      }
      const parsedAvailable = parsed.available;
      if (isPlainObject(parsedAvailable)) {
        for (const [key, value] of Object.entries(parsedAvailable)) {
          if (isPlainObject(value) && typeof value.expiresAt === 'number' && value.expiresAt > now) {
            available[key] = { utxo: value.utxo as ChainUtxo, expiresAt: value.expiresAt };
          }
        }
      }
    }
    journalSnapshot = { mtimeMs, journal: { spent, available } };
    return journalSnapshot.journal;
  } catch {
    return { spent: {}, available: {} };
  }
}

function writePersistedJournal(journal: PersistedPendingUtxoJournal): void {
  if (!persistentJournalPath) return;
  try {
    mkdirSync(path.dirname(persistentJournalPath), { recursive: true });
    const tempPath = `${persistentJournalPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(journal)}\n`, 'utf8');
    renameSync(tempPath, persistentJournalPath);
    journalSnapshot = null;
  } catch {
    // Best-effort: a failed journal write degrades to in-memory-only
    // tracking, which is today's behavior.
  }
}

function prunePendingMvcUtxos(now: number = Date.now()): void {
  for (const [key, value] of pendingSpentOutpoints.entries()) {
    if (value.expiresAt <= now) pendingSpentOutpoints.delete(key);
  }
  for (const [key, value] of pendingAvailableUtxos.entries()) {
    if (value.expiresAt <= now) pendingAvailableUtxos.delete(key);
  }
}

export function rememberPendingMvcTransaction(input: {
  address: string;
  spentUtxos: ChainUtxo[];
  createdUtxos: ChainUtxo[];
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  prunePendingMvcUtxos(now);
  const expiresAt = now + MVC_PENDING_UTXO_TTL_MS;
  for (const utxo of input.spentUtxos) {
    const key = getMvcUtxoOutpointKey({
      address: input.address,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
    });
    pendingSpentOutpoints.set(key, { expiresAt });
    pendingAvailableUtxos.delete(key);
  }
  for (const utxo of input.createdUtxos) {
    if (utxo.satoshis < 600) continue;
    const key = getMvcUtxoOutpointKey({
      address: input.address,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
    });
    if (!pendingSpentOutpoints.has(key)) {
      pendingAvailableUtxos.set(key, { utxo, expiresAt });
    }
  }
  if (!persistentJournalPath) return;
  // Merge this update into the on-disk state so concurrent processes keep
  // each other's entries (last rename wins the file; entries are pruned by
  // TTL, so a lost update ages out instead of poisoning spendability).
  const journal = readPersistedJournal(now);
  for (const utxo of input.spentUtxos) {
    const key = getMvcUtxoOutpointKey({
      address: input.address,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
    });
    journal.spent[key] = expiresAt;
    delete journal.available[key];
  }
  for (const utxo of input.createdUtxos) {
    if (utxo.satoshis < 600) continue;
    const key = getMvcUtxoOutpointKey({
      address: input.address,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
    });
    if (!(key in journal.spent)) {
      journal.available[key] = { utxo, expiresAt };
    }
  }
  writePersistedJournal(journal);
}

export function resolveSpendableMvcUtxos(input: {
  address: string;
  utxos: ChainUtxo[];
  now?: number;
}): ChainUtxo[] {
  const now = input.now ?? Date.now();
  prunePendingMvcUtxos(now);
  const merged = new Map<string, ChainUtxo>();
  for (const utxo of input.utxos) {
    merged.set(getMvcUtxoOutpointKey({
      address: input.address,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
    }), utxo);
  }
  const persisted = persistentJournalPath ? readPersistedJournal(now) : null;
  const collectPending = (entries: Map<string, PendingAvailableUtxo>): void => {
    for (const [key, value] of entries.entries()) {
      if (value.expiresAt > now && normalizeText(value.utxo.address) === normalizeText(input.address)) {
        merged.set(key, value.utxo);
      }
    }
  };
  collectPending(pendingAvailableUtxos);
  if (persisted) {
    for (const [key, value] of Object.entries(persisted.available)) {
      // The snapshot may be cached from an earlier read: re-check expiry
      // against this call's `now`.
      if (value.expiresAt > now && normalizeText(value.utxo.address) === normalizeText(input.address)) {
        merged.set(key, value.utxo);
      }
    }
  }
  const isSpent = (key: string): boolean => {
    const inMemory = pendingSpentOutpoints.get(key);
    if (inMemory && inMemory.expiresAt > now) return true;
    const onDisk = persisted?.spent[key];
    return typeof onDisk === 'number' && onDisk > now;
  };
  return [...merged.entries()]
    .filter(([key]) => !isSpent(key))
    .map(([, utxo]) => utxo);
}

export function __clearPendingMvcUtxosForTests(): void {
  pendingSpentOutpoints.clear();
  pendingAvailableUtxos.clear();
  journalSnapshot = null;
}

export function __setPendingMvcUtxoJournalPathForTests(value: string | null): void {
  persistentJournalPath = value ? value : null;
  journalSnapshot = null;
}
