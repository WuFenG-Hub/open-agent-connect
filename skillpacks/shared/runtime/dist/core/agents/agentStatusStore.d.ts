/**
 * In-memory agent status store: one row per (provider, session), updated by
 * normalized hook events and consumed by the daemon's status snapshot and SSE
 * subscribers. Sessions silent past the stale window are dropped on
 * snapshot/ingest so a crashed CLI cannot pin a phantom "working" row.
 */
import { type AgentStatusEvent, type AgentStatusRecord } from './agentStatusTypes';
export interface AgentStatusStore {
    ingest(event: AgentStatusEvent): void;
    snapshot(now?: () => number): AgentStatusRecord[];
    subscribe(listener: (event: AgentStatusEvent, record: AgentStatusRecord) => void): () => void;
}
export declare function createAgentStatusStore(now?: () => number): AgentStatusStore;
