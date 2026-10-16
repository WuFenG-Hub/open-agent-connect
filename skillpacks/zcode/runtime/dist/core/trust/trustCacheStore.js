"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTrustCacheStore = createTrustCacheStore;
// Trust cache: resolved /info/owner chains keyed by subject GlobalMetaID,
// stored machine-wide at `~/.metabot/owner/trust-cache.json` (storage-layout
// v2 amendment 2026-10-16). Each entry records the pinId its resolution is
// based on, so an entry is stale exactly when a newer binding pin lands; the
// resolver additionally bounds staleness with a TTL and exposes explicit
// per-subject invalidation. Atomic write-then-rename, 0600, lazily
// materialized, defensive normalization on read.
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const deriveIdentity_1 = require("../identity/deriveIdentity");
const paths_1 = require("../state/paths");
const TRUST_CACHE_FILE_MODE = 0o600;
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function normalizeChainLink(value) {
    if (!isRecord(value))
        return null;
    const subjectGmid = (0, deriveIdentity_1.normalizeGlobalMetaId)(value.subjectGmid);
    const ownerGmid = (0, deriveIdentity_1.normalizeGlobalMetaId)(value.ownerGmid);
    const pinId = typeof value.pinId === 'string' ? value.pinId.trim() : '';
    if (!subjectGmid || !ownerGmid || !pinId)
        return null;
    return { subjectGmid, ownerGmid, pinId };
}
function normalizeEntry(subjectKey, value) {
    if (!isRecord(value))
        return null;
    const subjectGlobalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(value.subjectGlobalMetaId) ?? (0, deriveIdentity_1.normalizeGlobalMetaId)(subjectKey);
    const rootOwnerGlobalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(value.rootOwnerGlobalMetaId);
    if (!subjectGlobalMetaId || !rootOwnerGlobalMetaId)
        return null;
    const chain = Array.isArray(value.chain)
        ? value.chain.map(normalizeChainLink).filter((link) => link !== null)
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
function normalizeGrant(value) {
    if (!isRecord(value))
        return null;
    const trustedOwner = (0, deriveIdentity_1.normalizeGlobalMetaId)(value.trustedOwner);
    const grantPinId = typeof value.grantPinId === 'string' ? value.grantPinId.trim() : '';
    const ts = Number(value.ts);
    if (!trustedOwner || !grantPinId || !Number.isFinite(ts))
        return null;
    const note = typeof value.note === 'string' && value.note.trim() ? value.note.trim() : undefined;
    return note ? { trustedOwner, note, ts, grantPinId } : { trustedOwner, ts, grantPinId };
}
function normalizeGrantEntry(ownerKey, value) {
    if (!isRecord(value))
        return null;
    const ownerGlobalMetaId = (0, deriveIdentity_1.normalizeGlobalMetaId)(value.ownerGlobalMetaId) ?? (0, deriveIdentity_1.normalizeGlobalMetaId)(ownerKey);
    if (!ownerGlobalMetaId)
        return null;
    const trustedOwners = Array.isArray(value.trustedOwners)
        ? value.trustedOwners.map(normalizeGrant).filter((grant) => grant !== null)
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
async function readCacheFile(filePath) {
    let raw;
    try {
        raw = JSON.parse(await node_fs_1.promises.readFile(filePath, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { entries: {}, grants: {} };
        // A corrupt cache must never break resolution — re-resolve from chain.
        return { entries: {}, grants: {} };
    }
    if (!isRecord(raw) || !isRecord(raw.entries))
        return { entries: {}, grants: {} };
    const entries = {};
    for (const [key, value] of Object.entries(raw.entries)) {
        const entry = normalizeEntry(key, value);
        if (entry)
            entries[entry.subjectGlobalMetaId] = entry;
    }
    const grants = {};
    if (isRecord(raw.grants)) {
        for (const [key, value] of Object.entries(raw.grants)) {
            const grant = normalizeGrantEntry(key, value);
            if (grant)
                grants[grant.ownerGlobalMetaId] = grant;
        }
    }
    return { entries, grants };
}
async function applyTrustCacheFileMode(filePath) {
    if (process.platform === 'win32')
        return;
    try {
        await node_fs_1.promises.chmod(filePath, TRUST_CACHE_FILE_MODE);
    }
    catch (error) {
        const code = error.code;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL')
            return;
        throw error;
    }
}
async function writeCacheFile(filePath, data) {
    const payload = { version: 1, entries: data.entries, grants: data.grants };
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    try {
        await node_fs_1.promises.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
            encoding: 'utf8',
            mode: TRUST_CACHE_FILE_MODE,
        });
        await node_fs_1.promises.rename(tempPath, filePath);
        await applyTrustCacheFileMode(filePath);
    }
    finally {
        await node_fs_1.promises.rm(tempPath, { force: true }).catch(() => { });
    }
}
function createTrustCacheStore(systemHomeDir) {
    const filePath = (0, paths_1.resolveMetabotOwnerPaths)(systemHomeDir).trustCachePath;
    return {
        async get(subjectGlobalMetaId) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(subjectGlobalMetaId);
            if (!normalized)
                return null;
            return (await readCacheFile(filePath)).entries[normalized] ?? null;
        },
        async set(entry) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(entry.subjectGlobalMetaId);
            if (!normalized)
                return;
            const data = await readCacheFile(filePath);
            data.entries[normalized] = { ...entry, subjectGlobalMetaId: normalized };
            await writeCacheFile(filePath, data);
        },
        async invalidate(subjectGlobalMetaId) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(subjectGlobalMetaId);
            if (!normalized)
                return;
            const data = await readCacheFile(filePath);
            if (!(normalized in data.entries))
                return;
            delete data.entries[normalized];
            await writeCacheFile(filePath, data);
        },
        async getGrants(ownerGlobalMetaId) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(ownerGlobalMetaId);
            if (!normalized)
                return null;
            return (await readCacheFile(filePath)).grants[normalized] ?? null;
        },
        async setGrants(entry) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(entry.ownerGlobalMetaId);
            if (!normalized)
                return;
            const data = await readCacheFile(filePath);
            data.grants[normalized] = { ...entry, ownerGlobalMetaId: normalized };
            await writeCacheFile(filePath, data);
        },
        async invalidateGrants(ownerGlobalMetaId) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(ownerGlobalMetaId);
            if (!normalized)
                return;
            const data = await readCacheFile(filePath);
            if (!(normalized in data.grants))
                return;
            delete data.grants[normalized];
            await writeCacheFile(filePath, data);
        },
        async clear() {
            await writeCacheFile(filePath, { entries: {}, grants: {} });
        },
    };
}
