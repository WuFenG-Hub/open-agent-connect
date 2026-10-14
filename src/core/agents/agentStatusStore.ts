/**
 * In-memory agent status store: one row per (provider, session), updated by
 * normalized hook events and consumed by the daemon's status snapshot and SSE
 * subscribers. Sessions silent past the stale window are dropped on
 * snapshot/ingest so a crashed CLI cannot pin a phantom "working" row.
 */
import { AGENT_STATUS_STALE_AFTER_MS, type AgentStatusEvent, type AgentStatusRecord } from './agentStatusTypes';

export interface AgentStatusStore {
  ingest(event: AgentStatusEvent): void;
  snapshot(now?: () => number): AgentStatusRecord[];
  subscribe(listener: (event: AgentStatusEvent, record: AgentStatusRecord) => void): () => void;
}

function sessionKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

export function createAgentStatusStore(now: () => number = Date.now): AgentStatusStore {
  const rows = new Map<string, AgentStatusRecord>();
  const listeners = new Set<(event: AgentStatusEvent, record: AgentStatusRecord) => void>();

  const reapStale = (): void => {
    const cutoff = now() - AGENT_STATUS_STALE_AFTER_MS;
    for (const [key, row] of rows) {
      if (row.updatedAt < cutoff) rows.delete(key);
    }
  };

  return {
    ingest(event) {
      reapStale();
      const key = sessionKey(event.provider, event.sessionId);
      const existing = rows.get(key);
      const stateChanged = !existing || existing.state !== event.state;
      const record: AgentStatusRecord = {
        provider: event.provider,
        sessionId: event.sessionId,
        state: event.state,
        cwd: event.cwd || existing?.cwd || '',
        transcriptPath: event.transcriptPath || existing?.transcriptPath || '',
        prompt: event.prompt || existing?.prompt || '',
        toolName: event.toolName,
        sessionBoundary: event.sessionBoundary,
        firstObservedAt: existing?.firstObservedAt ?? event.observedAt,
        stateStartedAt: stateChanged ? event.observedAt : (existing?.stateStartedAt ?? event.observedAt),
        updatedAt: event.observedAt,
        lastHookEvent: event.hookEventName,
      };
      rows.set(key, record);
      for (const listener of listeners) {
        listener(event, record);
      }
    },
    snapshot(snapshotNow = now) {
      const cutoff = snapshotNow() - AGENT_STATUS_STALE_AFTER_MS;
      return Array.from(rows.values())
        .filter((row) => row.updatedAt >= cutoff)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
