import { toOwnerIdentityPublic, type OwnerIdentityPublic, type OwnerIdentityRecord } from './ownerIdentity';
export type RootOwnerIdentityRecord = OwnerIdentityRecord;
export type RootOwnerIdentityPublic = OwnerIdentityPublic;
export declare class RootOwnerIdentityError extends Error {
    readonly code: 'root_owner_exists' | 'root_owner_missing' | 'invalid_mnemonic' | 'invalid_name';
    constructor(code: 'root_owner_exists' | 'root_owner_missing' | 'invalid_mnemonic' | 'invalid_name', message: string);
}
export declare function resolveRootOwnerIdentityPath(systemHomeDir: string): string;
export declare const toRootOwnerIdentityPublic: typeof toOwnerIdentityPublic;
/** The root owner identity record, or null when this machine has none. */
export declare function loadRootOwnerIdentity(systemHomeDir: string): Promise<RootOwnerIdentityRecord | null>;
/** True when a root owner identity exists on this machine. */
export declare function rootOwnerExists(systemHomeDir: string): Promise<boolean>;
/** Create a brand-new root owner identity (fresh mnemonic). Fails if one exists. */
export declare function createRootOwnerIdentity(systemHomeDir: string, input: {
    name: string;
}): Promise<RootOwnerIdentityRecord>;
/** Import the root owner identity from an existing mnemonic. Fails if one exists. */
export declare function importRootOwnerIdentity(systemHomeDir: string, input: {
    name: string;
    mnemonic: string;
    path?: string;
}): Promise<RootOwnerIdentityRecord>;
/** Rename the root owner identity. */
export declare function renameRootOwnerIdentity(systemHomeDir: string, name: string): Promise<RootOwnerIdentityRecord>;
/** Reveal the stored mnemonic (backup view; same guarded channel as the device identity reveal). */
export declare function revealRootOwnerMnemonic(systemHomeDir: string): Promise<string>;
/** Delete the root owner identity. The device identity and its Bot bindings are untouched. */
export declare function deleteRootOwnerIdentity(systemHomeDir: string): Promise<void>;
