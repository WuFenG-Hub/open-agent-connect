"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toRootOwnerIdentityPublic = exports.RootOwnerIdentityError = void 0;
exports.resolveRootOwnerIdentityPath = resolveRootOwnerIdentityPath;
exports.loadRootOwnerIdentity = loadRootOwnerIdentity;
exports.rootOwnerExists = rootOwnerExists;
exports.createRootOwnerIdentity = createRootOwnerIdentity;
exports.importRootOwnerIdentity = importRootOwnerIdentity;
exports.renameRootOwnerIdentity = renameRootOwnerIdentity;
exports.revealRootOwnerMnemonic = revealRootOwnerMnemonic;
exports.deleteRootOwnerIdentity = deleteRootOwnerIdentity;
// The root Owner Identity: the human's portable, machine-wide MetaID identity
// introduced by the trust tiers design (Bot -> Device -> Owner). It is the
// top layer above the per-machine Device Identity (`ownerIdentity.ts`, the
// identity formerly called "owner"): a device binds to its owner by
// publishing an /info/owner pin FROM the device identity whose payload
// embeds this record's signature (see ownerBinding.ts / deviceOwnerBinding.ts).
// Same record shape as the device identity; stored 0600, at most one per
// machine, and created/imported explicitly — never auto-provisioned.
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const bip39 = __importStar(require("@scure/bip39"));
const english_1 = require("@scure/bip39/wordlists/english");
const deriveIdentity_1 = require("../identity/deriveIdentity");
const paths_1 = require("../state/paths");
const ownerIdentity_1 = require("./ownerIdentity");
const ROOT_OWNER_FILE_MODE = 0o600;
class RootOwnerIdentityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'RootOwnerIdentityError';
    }
}
exports.RootOwnerIdentityError = RootOwnerIdentityError;
function resolveRootOwnerIdentityPath(systemHomeDir) {
    return (0, paths_1.resolveMetabotOwnerPaths)(systemHomeDir).rootOwnerIdentityPath;
}
exports.toRootOwnerIdentityPublic = ownerIdentity_1.toOwnerIdentityPublic;
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readString(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
function normalizeRootOwnerIdentityRecord(value) {
    if (!isRecord(value))
        return null;
    const mnemonic = readString(value, 'mnemonic');
    const globalMetaId = readString(value, 'globalMetaId');
    const mvcAddress = readString(value, 'mvcAddress');
    if (!mnemonic || !globalMetaId || !mvcAddress)
        return null;
    return {
        version: 1,
        name: readString(value, 'name') || ownerIdentity_1.DEFAULT_OWNER_NAME,
        mnemonic,
        path: readString(value, 'path') || deriveIdentity_1.DEFAULT_DERIVATION_PATH,
        publicKey: readString(value, 'publicKey'),
        chatPublicKey: readString(value, 'chatPublicKey'),
        mvcAddress,
        metaId: readString(value, 'metaId'),
        globalMetaId,
        ...(readString(value, 'avatarDataUrl') ? { avatarDataUrl: readString(value, 'avatarDataUrl') } : {}),
        createdAt: readString(value, 'createdAt'),
        updatedAt: readString(value, 'updatedAt'),
    };
}
/** The root owner identity record, or null when this machine has none. */
async function loadRootOwnerIdentity(systemHomeDir) {
    try {
        const raw = await node_fs_1.promises.readFile(resolveRootOwnerIdentityPath(systemHomeDir), 'utf8');
        return normalizeRootOwnerIdentityRecord(JSON.parse(raw));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
/** True when a root owner identity exists on this machine. */
async function rootOwnerExists(systemHomeDir) {
    return (await loadRootOwnerIdentity(systemHomeDir)) !== null;
}
async function applyRootOwnerFileMode(filePath) {
    if (process.platform === 'win32')
        return;
    try {
        await node_fs_1.promises.chmod(filePath, ROOT_OWNER_FILE_MODE);
    }
    catch (error) {
        const code = error.code;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL')
            return;
        throw error;
    }
}
async function writeRootOwnerIdentityFile(systemHomeDir, record) {
    const filePath = resolveRootOwnerIdentityPath(systemHomeDir);
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    await node_fs_1.promises.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: ROOT_OWNER_FILE_MODE,
    });
    await applyRootOwnerFileMode(filePath);
}
function cleanName(name) {
    return name.trim();
}
function persistDerived(systemHomeDir, name, derived) {
    const now = new Date().toISOString();
    return {
        version: 1,
        name: cleanName(name) || ownerIdentity_1.DEFAULT_OWNER_NAME,
        mnemonic: derived.mnemonic,
        path: derived.path,
        publicKey: derived.publicKey,
        chatPublicKey: derived.chatPublicKey,
        mvcAddress: derived.mvcAddress,
        metaId: derived.metaId,
        globalMetaId: derived.globalMetaId,
        createdAt: now,
        updatedAt: now,
    };
}
/** Create a brand-new root owner identity (fresh mnemonic). Fails if one exists. */
async function createRootOwnerIdentity(systemHomeDir, input) {
    const existing = await loadRootOwnerIdentity(systemHomeDir);
    if (existing) {
        throw new RootOwnerIdentityError('root_owner_exists', 'A root owner identity already exists on this machine.');
    }
    const derived = await (0, deriveIdentity_1.deriveIdentity)({});
    const record = persistDerived(systemHomeDir, input.name, derived);
    await writeRootOwnerIdentityFile(systemHomeDir, record);
    return record;
}
/** Import the root owner identity from an existing mnemonic. Fails if one exists. */
async function importRootOwnerIdentity(systemHomeDir, input) {
    const existing = await loadRootOwnerIdentity(systemHomeDir);
    if (existing) {
        throw new RootOwnerIdentityError('root_owner_exists', 'A root owner identity already exists on this machine.');
    }
    const mnemonic = input.mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!bip39.validateMnemonic(mnemonic, english_1.wordlist)) {
        throw new RootOwnerIdentityError('invalid_mnemonic', 'The mnemonic is not a valid BIP39 phrase.');
    }
    const derived = await (0, deriveIdentity_1.deriveIdentity)({ mnemonic, path: input.path?.trim() || deriveIdentity_1.DEFAULT_DERIVATION_PATH });
    const record = persistDerived(systemHomeDir, input.name, derived);
    await writeRootOwnerIdentityFile(systemHomeDir, record);
    return record;
}
/** Rename the root owner identity. */
async function renameRootOwnerIdentity(systemHomeDir, name) {
    const current = await loadRootOwnerIdentity(systemHomeDir);
    if (!current) {
        throw new RootOwnerIdentityError('root_owner_missing', 'No root owner identity exists on this machine.');
    }
    const nextName = cleanName(name);
    if (!nextName) {
        throw new RootOwnerIdentityError('invalid_name', 'Name must not be empty.');
    }
    const record = { ...current, name: nextName, updatedAt: new Date().toISOString() };
    await writeRootOwnerIdentityFile(systemHomeDir, record);
    return record;
}
/** Reveal the stored mnemonic (backup view; same guarded channel as the device identity reveal). */
async function revealRootOwnerMnemonic(systemHomeDir) {
    const current = await loadRootOwnerIdentity(systemHomeDir);
    if (!current) {
        throw new RootOwnerIdentityError('root_owner_missing', 'No root owner identity exists on this machine.');
    }
    return current.mnemonic;
}
/** Delete the root owner identity. The device identity and its Bot bindings are untouched. */
async function deleteRootOwnerIdentity(systemHomeDir) {
    try {
        await node_fs_1.promises.unlink(resolveRootOwnerIdentityPath(systemHomeDir));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
