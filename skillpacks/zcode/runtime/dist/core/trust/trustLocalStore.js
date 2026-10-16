"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTrustLocalState = normalizeTrustLocalState;
exports.createTrustLocalStore = createTrustLocalStore;
exports.blockGmid = blockGmid;
exports.unblockGmid = unblockGmid;
exports.listBlockedGmids = listBlockedGmids;
exports.isBlockedGmid = isBlockedGmid;
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
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const deriveIdentity_1 = require("../identity/deriveIdentity");
const paths_1 = require("../state/paths");
const trustCacheStore_1 = require("./trustCacheStore");
const TRUST_LOCAL_FILE_MODE = 0o600;
function normalizeGmidList(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const result = [];
    for (const item of value) {
        const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(item);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}
function normalizeTrustLocalState(value) {
    const record = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    return {
        blocked: normalizeGmidList(record.blocked),
        contacts: normalizeGmidList(record.contacts),
    };
}
async function applyTrustLocalFileMode(filePath) {
    if (process.platform === 'win32')
        return;
    try {
        await node_fs_1.promises.chmod(filePath, TRUST_LOCAL_FILE_MODE);
    }
    catch (error) {
        const code = error.code;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL')
            return;
        throw error;
    }
}
async function writeTrustLocalFile(filePath, state) {
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    try {
        await node_fs_1.promises.writeFile(tempPath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, {
            encoding: 'utf8',
            mode: TRUST_LOCAL_FILE_MODE,
        });
        await node_fs_1.promises.rename(tempPath, filePath);
        await applyTrustLocalFileMode(filePath);
    }
    finally {
        await node_fs_1.promises.rm(tempPath, { force: true }).catch(() => { });
    }
}
function createTrustLocalStore(systemHomeDir) {
    const filePath = (0, paths_1.resolveMetabotOwnerPaths)(systemHomeDir).trustLocalPath;
    return {
        async read() {
            let raw;
            try {
                raw = JSON.parse(await node_fs_1.promises.readFile(filePath, 'utf8'));
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return { blocked: [], contacts: [] };
                // A corrupt local store must never break chat ingress — start empty.
                return { blocked: [], contacts: [] };
            }
            return normalizeTrustLocalState(raw);
        },
        async setBlocked(globalMetaId, blocked) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(globalMetaId);
            if (!normalized)
                throw new Error(`Invalid GlobalMetaID: ${String(globalMetaId)}`);
            const state = await this.read();
            const next = {
                ...state,
                blocked: blocked
                    ? [...state.blocked.filter((g) => g !== normalized), normalized]
                    : state.blocked.filter((g) => g !== normalized),
            };
            await writeTrustLocalFile(filePath, next);
            return next;
        },
        async setContact(globalMetaId, contact) {
            const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(globalMetaId);
            if (!normalized)
                throw new Error(`Invalid GlobalMetaID: ${String(globalMetaId)}`);
            const state = await this.read();
            const next = {
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
async function blockGmid(systemHomeDir, globalMetaId) {
    const state = await createTrustLocalStore(systemHomeDir).setBlocked(globalMetaId, true);
    await (0, trustCacheStore_1.createTrustCacheStore)(systemHomeDir).invalidate(globalMetaId);
    return state;
}
async function unblockGmid(systemHomeDir, globalMetaId) {
    const state = await createTrustLocalStore(systemHomeDir).setBlocked(globalMetaId, false);
    await (0, trustCacheStore_1.createTrustCacheStore)(systemHomeDir).invalidate(globalMetaId);
    return state;
}
async function listBlockedGmids(systemHomeDir) {
    return (await createTrustLocalStore(systemHomeDir).read()).blocked;
}
async function isBlockedGmid(systemHomeDir, globalMetaId) {
    const normalized = (0, deriveIdentity_1.normalizeGlobalMetaId)(globalMetaId);
    if (!normalized)
        return false;
    return (await listBlockedGmids(systemHomeDir)).includes(normalized);
}
