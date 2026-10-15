export declare const AGENT_HOOK_PROTOCOL_VERSION = "1";
export declare const AGENT_HOOK_ENDPOINT_FILENAME = "hook-endpoint.env";
export declare const AGENT_HOOK_SPOOL_DIRNAME = "spool";
export declare const AGENT_HOOK_SPOOL_MAX_BYTES: number;
export declare const AGENT_HOOK_SPOOL_MAX_AGE_MS: number;
export interface AgentHookEndpoint {
    port: number;
    token: string;
    version: string;
}
export declare function endpointFilePath(agentsDir: string): string;
export declare function spoolDirPath(agentsDir: string): string;
export declare function newAgentHookToken(): string;
export declare function renderEndpointFile(endpoint: AgentHookEndpoint): string;
/** Atomic, 0600 write; the parent dir is created 0700. */
export declare function writeAgentHookEndpointFile(agentsDir: string, endpoint: AgentHookEndpoint): Promise<void>;
export declare function readAgentHookEndpointFile(agentsDir: string): Promise<AgentHookEndpoint | null>;
/**
 * Replay spooled hook records written while the daemon was down. Only
 * newline-terminated records are read (a torn trailing line belongs to a
 * still-writing hook); the file is truncated in place so concurrent appenders
 * keep their inode.
 */
export declare function drainAgentHookSpool(dir: string, ingest: (record: {
    source: string;
    payload: unknown;
    receivedAt: number;
}) => void, now?: () => number): Promise<number>;
