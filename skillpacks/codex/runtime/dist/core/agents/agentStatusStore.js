"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAgentStatusStore = createAgentStatusStore;
/**
 * In-memory agent status store: one row per (provider, session), updated by
 * normalized hook events and consumed by the daemon's status snapshot and SSE
 * subscribers. Sessions silent past the stale window are dropped on
 * snapshot/ingest so a crashed CLI cannot pin a phantom "working" row.
 */
const agentStatusTypes_1 = require("./agentStatusTypes");
function sessionKey(provider, sessionId) {
    return `${provider}:${sessionId}`;
}
function createAgentStatusStore(now = Date.now) {
    const rows = new Map();
    const listeners = new Set();
    const reapStale = () => {
        const cutoff = now() - agentStatusTypes_1.AGENT_STATUS_STALE_AFTER_MS;
        for (const [key, row] of rows) {
            if (row.updatedAt < cutoff)
                rows.delete(key);
        }
    };
    return {
        ingest(event) {
            reapStale();
            const key = sessionKey(event.provider, event.sessionId);
            const existing = rows.get(key);
            const stateChanged = !existing || existing.state !== event.state;
            const record = {
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
            const cutoff = snapshotNow() - agentStatusTypes_1.AGENT_STATUS_STALE_AFTER_MS;
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
