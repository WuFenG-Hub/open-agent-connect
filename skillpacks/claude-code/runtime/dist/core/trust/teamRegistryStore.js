"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTeamRegistryStore = createTeamRegistryStore;
exports.listTeamRegistryGmids = listTeamRegistryGmids;
// Team registry (trust tiers P4b/P5): the machine-wide list of REMOTE team
// Bot gmids — Bots on other devices bound to the same root owner. Entries are
// recorded manually via `metabot team add` (verified same root owner on-chain
// before recording, source 'manual') or auto-recorded by the peer tier
// resolver when a peer resolves to the 'team' tier (source 'auto'). The file
// is OPTIONAL: absence, a corrupt file, or junk rows all read as an empty
// registry — every consumer must still verify tier at the point of use
// (createGroupTask enforces tier 'team').
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const deriveIdentity_1 = require("../identity/deriveIdentity");
const paths_1 = require("../state/paths");
const TEAM_REGISTRY_FILE_MODE = 0o600;
function normalizeSource(value) {
    return value === 'auto' ? 'auto' : 'manual';
}
function normalizeEntries(value) {
    const raw = Array.isArray(value)
        ? value
        : value && typeof value === 'object'
            ? value.teamBots
            : null;
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const entries = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object')
            continue;
        const record = item;
        const globalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(record.globalMetaId);
        if (!globalMetaId || seen.has(globalMetaId))
            continue;
        seen.add(globalMetaId);
        const entry = { globalMetaId, source: normalizeSource(record.source) };
        const addedAt = typeof record.addedAt === 'string' && record.addedAt.trim() ? record.addedAt.trim() : '';
        if (addedAt)
            entry.addedAt = addedAt;
        const note = typeof record.note === 'string' && record.note.trim() ? record.note.trim() : '';
        if (note)
            entry.note = note;
        entries.push(entry);
    }
    return entries;
}
async function applyTeamRegistryFileMode(filePath) {
    if (process.platform === 'win32')
        return;
    try {
        await node_fs_1.promises.chmod(filePath, TEAM_REGISTRY_FILE_MODE);
    }
    catch (error) {
        const code = error.code;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL')
            return;
        throw error;
    }
}
async function writeRegistryFile(filePath, entries) {
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    try {
        await node_fs_1.promises.writeFile(tempPath, `${JSON.stringify({ version: 1, teamBots: entries }, null, 2)}\n`, {
            encoding: 'utf8',
            mode: TEAM_REGISTRY_FILE_MODE,
        });
        await node_fs_1.promises.rename(tempPath, filePath);
        await applyTeamRegistryFileMode(filePath);
    }
    finally {
        await node_fs_1.promises.rm(tempPath, { force: true }).catch(() => { });
    }
}
function createTeamRegistryStore(systemHomeDir) {
    const filePath = (0, paths_1.resolveMetabotOwnerPaths)(systemHomeDir).teamRegistryPath;
    async function readEntries() {
        let raw;
        try {
            raw = JSON.parse(await node_fs_1.promises.readFile(filePath, 'utf8'));
        }
        catch {
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
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(entry.globalMetaId);
            if (!normalized)
                throw new Error(`Invalid GlobalMetaID: ${String(entry.globalMetaId)}`);
            const entries = await readEntries();
            const nextEntry = { ...entry, globalMetaId: normalized };
            const index = entries.findIndex((existing) => existing.globalMetaId === normalized);
            if (index >= 0) {
                // Preserve the original addedAt unless the new entry carries one.
                nextEntry.addedAt = nextEntry.addedAt ?? entries[index].addedAt;
                entries[index] = nextEntry;
            }
            else {
                entries.push(nextEntry);
            }
            await writeRegistryFile(filePath, entries);
            return entries;
        },
        async remove(globalMetaId) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(globalMetaId);
            if (!normalized)
                throw new Error(`Invalid GlobalMetaID: ${String(globalMetaId)}`);
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
async function listTeamRegistryGmids(systemHomeDir) {
    return (await createTeamRegistryStore(systemHomeDir).list()).map((entry) => entry.globalMetaId);
}
