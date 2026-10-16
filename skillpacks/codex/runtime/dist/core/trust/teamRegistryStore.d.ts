export type TeamRegistrySource = 'manual' | 'auto';
export interface TeamRegistryEntry {
    globalMetaId: string;
    source: TeamRegistrySource;
    addedAt?: string;
    note?: string;
}
export interface TeamRegistryStore {
    list(): Promise<TeamRegistryEntry[]>;
    /** Insert or replace one entry (matched by gmid, normalized). */
    upsert(entry: TeamRegistryEntry): Promise<TeamRegistryEntry[]>;
    /** Drop one entry; a no-op when absent. */
    remove(globalMetaId: string): Promise<TeamRegistryEntry[]>;
}
export declare function createTeamRegistryStore(systemHomeDir: string): TeamRegistryStore;
/** Remote team Bot gmids recorded on this machine (empty when none/unreadable). */
export declare function listTeamRegistryGmids(systemHomeDir: string): Promise<string[]>;
