// The root Owner Identity: the human's portable, machine-wide MetaID identity
// introduced by the trust tiers design (Bot -> Device -> Owner). It is the
// top layer above the per-machine Device Identity (`ownerIdentity.ts`, the
// identity formerly called "owner"): a device binds to its owner by
// publishing an /info/owner pin FROM the device identity whose payload
// embeds this record's signature (see ownerBinding.ts / deviceOwnerBinding.ts).
// Same record shape as the device identity; stored 0600, at most one per
// machine, and created/imported explicitly — never auto-provisioned.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { DEFAULT_DERIVATION_PATH, deriveIdentity } from '../identity/deriveIdentity';
import { resolveMetabotOwnerPaths } from '../state/paths';
import {
  DEFAULT_OWNER_NAME,
  toOwnerIdentityPublic,
  type OwnerIdentityPublic,
  type OwnerIdentityRecord,
} from './ownerIdentity';

const ROOT_OWNER_FILE_MODE = 0o600;

export type RootOwnerIdentityRecord = OwnerIdentityRecord;
export type RootOwnerIdentityPublic = OwnerIdentityPublic;

export class RootOwnerIdentityError extends Error {
  constructor(
    readonly code: 'root_owner_exists' | 'root_owner_missing' | 'invalid_mnemonic' | 'invalid_name',
    message: string,
  ) {
    super(message);
    this.name = 'RootOwnerIdentityError';
  }
}

export function resolveRootOwnerIdentityPath(systemHomeDir: string): string {
  return resolveMetabotOwnerPaths(systemHomeDir).rootOwnerIdentityPath;
}

export const toRootOwnerIdentityPublic = toOwnerIdentityPublic;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function normalizeRootOwnerIdentityRecord(value: unknown): RootOwnerIdentityRecord | null {
  if (!isRecord(value)) return null;
  const mnemonic = readString(value, 'mnemonic');
  const globalMetaId = readString(value, 'globalMetaId');
  const mvcAddress = readString(value, 'mvcAddress');
  if (!mnemonic || !globalMetaId || !mvcAddress) return null;
  return {
    version: 1,
    name: readString(value, 'name') || DEFAULT_OWNER_NAME,
    mnemonic,
    path: readString(value, 'path') || DEFAULT_DERIVATION_PATH,
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
export async function loadRootOwnerIdentity(systemHomeDir: string): Promise<RootOwnerIdentityRecord | null> {
  try {
    const raw = await fs.readFile(resolveRootOwnerIdentityPath(systemHomeDir), 'utf8');
    return normalizeRootOwnerIdentityRecord(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** True when a root owner identity exists on this machine. */
export async function rootOwnerExists(systemHomeDir: string): Promise<boolean> {
  return (await loadRootOwnerIdentity(systemHomeDir)) !== null;
}

async function applyRootOwnerFileMode(filePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await fs.chmod(filePath, ROOT_OWNER_FILE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EINVAL') return;
    throw error;
  }
}

async function writeRootOwnerIdentityFile(systemHomeDir: string, record: RootOwnerIdentityRecord): Promise<void> {
  const filePath = resolveRootOwnerIdentityPath(systemHomeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: ROOT_OWNER_FILE_MODE,
  });
  await applyRootOwnerFileMode(filePath);
}

function cleanName(name: string): string {
  return name.trim();
}

function persistDerived(
  systemHomeDir: string,
  name: string,
  derived: { mnemonic: string; path: string; publicKey: string; chatPublicKey: string; mvcAddress: string; metaId: string; globalMetaId: string },
): RootOwnerIdentityRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    name: cleanName(name) || DEFAULT_OWNER_NAME,
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
export async function createRootOwnerIdentity(
  systemHomeDir: string,
  input: { name: string },
): Promise<RootOwnerIdentityRecord> {
  const existing = await loadRootOwnerIdentity(systemHomeDir);
  if (existing) {
    throw new RootOwnerIdentityError('root_owner_exists', 'A root owner identity already exists on this machine.');
  }
  const derived = await deriveIdentity({});
  const record = persistDerived(systemHomeDir, input.name, derived);
  await writeRootOwnerIdentityFile(systemHomeDir, record);
  return record;
}

/** Import the root owner identity from an existing mnemonic. Fails if one exists. */
export async function importRootOwnerIdentity(
  systemHomeDir: string,
  input: { name: string; mnemonic: string; path?: string },
): Promise<RootOwnerIdentityRecord> {
  const existing = await loadRootOwnerIdentity(systemHomeDir);
  if (existing) {
    throw new RootOwnerIdentityError('root_owner_exists', 'A root owner identity already exists on this machine.');
  }
  const mnemonic = input.mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new RootOwnerIdentityError('invalid_mnemonic', 'The mnemonic is not a valid BIP39 phrase.');
  }
  const derived = await deriveIdentity({ mnemonic, path: input.path?.trim() || DEFAULT_DERIVATION_PATH });
  const record = persistDerived(systemHomeDir, input.name, derived);
  await writeRootOwnerIdentityFile(systemHomeDir, record);
  return record;
}

/** Rename the root owner identity. */
export async function renameRootOwnerIdentity(systemHomeDir: string, name: string): Promise<RootOwnerIdentityRecord> {
  const current = await loadRootOwnerIdentity(systemHomeDir);
  if (!current) {
    throw new RootOwnerIdentityError('root_owner_missing', 'No root owner identity exists on this machine.');
  }
  const nextName = cleanName(name);
  if (!nextName) {
    throw new RootOwnerIdentityError('invalid_name', 'Name must not be empty.');
  }
  const record: RootOwnerIdentityRecord = { ...current, name: nextName, updatedAt: new Date().toISOString() };
  await writeRootOwnerIdentityFile(systemHomeDir, record);
  return record;
}

/** Reveal the stored mnemonic (backup view; same guarded channel as the device identity reveal). */
export async function revealRootOwnerMnemonic(systemHomeDir: string): Promise<string> {
  const current = await loadRootOwnerIdentity(systemHomeDir);
  if (!current) {
    throw new RootOwnerIdentityError('root_owner_missing', 'No root owner identity exists on this machine.');
  }
  return current.mnemonic;
}

/** Delete the root owner identity. The device identity and its Bot bindings are untouched. */
export async function deleteRootOwnerIdentity(systemHomeDir: string): Promise<void> {
  try {
    await fs.unlink(resolveRootOwnerIdentityPath(systemHomeDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
