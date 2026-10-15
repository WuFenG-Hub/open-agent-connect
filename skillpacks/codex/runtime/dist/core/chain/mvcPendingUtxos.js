"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MVC_PENDING_UTXO_TTL_MS = void 0;
exports.getMvcUtxoOutpointKey = getMvcUtxoOutpointKey;
exports.configurePendingMvcUtxoPersistence = configurePendingMvcUtxoPersistence;
exports.rememberPendingMvcTransaction = rememberPendingMvcTransaction;
exports.resolveSpendableMvcUtxos = resolveSpendableMvcUtxos;
exports.__clearPendingMvcUtxosForTests = __clearPendingMvcUtxosForTests;
exports.__setPendingMvcUtxoJournalPathForTests = __setPendingMvcUtxoJournalPathForTests;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
exports.MVC_PENDING_UTXO_TTL_MS = 10 * 60 * 1000;
/** Maps address:txid:outputIndex to pending spent outpoint state. */
const pendingSpentOutpoints = new Map();
const pendingAvailableUtxos = new Map();
/**
 * Optional cross-process journal (best-effort, sync + atomic rename). The
 * in-memory maps die with the process, but explorer UTXO views lag several
 * seconds behind a broadcast — a CLI transfer followed by a daemon-side
 * upload would otherwise rebuild from already-spent outpoints and hit
 * txn-mempool-conflict. Wire-up: configurePendingMvcUtxoPersistence at
 * process start (daemon serve + CLI runtime); unit tests stay hermetic by
 * leaving it unconfigured.
 */
let persistentJournalPath = null;
let journalSnapshot = null;
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function normalizeOutpointTxid(value) {
    return normalizeText(value).toLowerCase();
}
function getMvcUtxoOutpointKey(input) {
    const outpointParts = [normalizeOutpointTxid(input.txId), String(input.outputIndex)];
    if (Object.hasOwn(input, 'address')) {
        return [normalizeText(input.address), ...outpointParts].join(':');
    }
    return outpointParts.join(':');
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function configurePendingMvcUtxoPersistence(input) {
    const normalized = normalizeText(input.journalPath);
    persistentJournalPath = normalized || null;
    journalSnapshot = null;
}
function readPersistedJournal(now) {
    if (!persistentJournalPath) {
        return { spent: {}, available: {} };
    }
    try {
        const mtimeMs = (0, node_fs_1.statSync)(persistentJournalPath).mtimeMs;
        if (journalSnapshot && journalSnapshot.mtimeMs === mtimeMs) {
            return journalSnapshot.journal;
        }
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(persistentJournalPath, 'utf8'));
        const spent = {};
        const available = {};
        if (isPlainObject(parsed)) {
            const parsedSpent = parsed.spent;
            if (isPlainObject(parsedSpent)) {
                for (const [key, value] of Object.entries(parsedSpent)) {
                    if (typeof value === 'number' && value > now)
                        spent[key] = value;
                }
            }
            const parsedAvailable = parsed.available;
            if (isPlainObject(parsedAvailable)) {
                for (const [key, value] of Object.entries(parsedAvailable)) {
                    if (isPlainObject(value) && typeof value.expiresAt === 'number' && value.expiresAt > now) {
                        available[key] = { utxo: value.utxo, expiresAt: value.expiresAt };
                    }
                }
            }
        }
        journalSnapshot = { mtimeMs, journal: { spent, available } };
        return journalSnapshot.journal;
    }
    catch {
        return { spent: {}, available: {} };
    }
}
function writePersistedJournal(journal) {
    if (!persistentJournalPath)
        return;
    try {
        (0, node_fs_1.mkdirSync)(node_path_1.default.dirname(persistentJournalPath), { recursive: true });
        const tempPath = `${persistentJournalPath}.${process.pid}.tmp`;
        (0, node_fs_1.writeFileSync)(tempPath, `${JSON.stringify(journal)}\n`, 'utf8');
        (0, node_fs_1.renameSync)(tempPath, persistentJournalPath);
        journalSnapshot = null;
    }
    catch {
        // Best-effort: a failed journal write degrades to in-memory-only
        // tracking, which is today's behavior.
    }
}
function prunePendingMvcUtxos(now = Date.now()) {
    for (const [key, value] of pendingSpentOutpoints.entries()) {
        if (value.expiresAt <= now)
            pendingSpentOutpoints.delete(key);
    }
    for (const [key, value] of pendingAvailableUtxos.entries()) {
        if (value.expiresAt <= now)
            pendingAvailableUtxos.delete(key);
    }
}
function rememberPendingMvcTransaction(input) {
    const now = input.now ?? Date.now();
    prunePendingMvcUtxos(now);
    const expiresAt = now + exports.MVC_PENDING_UTXO_TTL_MS;
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
        if (utxo.satoshis < 600)
            continue;
        const key = getMvcUtxoOutpointKey({
            address: input.address,
            txId: utxo.txId,
            outputIndex: utxo.outputIndex,
        });
        if (!pendingSpentOutpoints.has(key)) {
            pendingAvailableUtxos.set(key, { utxo, expiresAt });
        }
    }
    if (!persistentJournalPath)
        return;
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
        if (utxo.satoshis < 600)
            continue;
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
function resolveSpendableMvcUtxos(input) {
    const now = input.now ?? Date.now();
    prunePendingMvcUtxos(now);
    const merged = new Map();
    for (const utxo of input.utxos) {
        merged.set(getMvcUtxoOutpointKey({
            address: input.address,
            txId: utxo.txId,
            outputIndex: utxo.outputIndex,
        }), utxo);
    }
    const persisted = persistentJournalPath ? readPersistedJournal(now) : null;
    const collectPending = (entries) => {
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
    const isSpent = (key) => {
        const inMemory = pendingSpentOutpoints.get(key);
        if (inMemory && inMemory.expiresAt > now)
            return true;
        const onDisk = persisted?.spent[key];
        return typeof onDisk === 'number' && onDisk > now;
    };
    return [...merged.entries()]
        .filter(([key]) => !isSpent(key))
        .map(([, utxo]) => utxo);
}
function __clearPendingMvcUtxosForTests() {
    pendingSpentOutpoints.clear();
    pendingAvailableUtxos.clear();
    journalSnapshot = null;
}
function __setPendingMvcUtxoJournalPathForTests(value) {
    persistentJournalPath = value ? value : null;
    journalSnapshot = null;
}
