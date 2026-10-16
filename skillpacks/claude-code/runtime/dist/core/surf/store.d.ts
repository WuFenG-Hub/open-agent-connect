import type { MetabotPaths } from '../state/paths.js';
import { type SurfRunFailure } from './failure.js';
export type MetawebSurfTrigger = 'manual-chat' | 'manual-ui' | 'pre-dream';
export type MetawebSurfRunStatus = 'running' | 'done' | 'failed';
/**
 * Strongest action the bot has taken on a seen pin, ranked: briefing-only
 * actions first, then read/save, then chain-writing interactions. A later
 * markSeen with a lower rank must not downgrade the recorded action.
 */
export type MetawebSurfSeenAction = 'presented' | 'skipped' | 'read' | 'saved' | 'liked' | 'commented' | 'answered' | 'posted' | 'challenged';
/** Exported for the surf interaction guard (duplicate-interaction checks rank actions). */
export declare const SEEN_ACTION_RANK: Record<MetawebSurfSeenAction, number>;
export declare const SURF_SEEN_RETENTION_DAYS = 90;
export declare const SURF_SEEN_MAX_ROWS_PER_BOT = 5000;
/** A run record keeps at most this many characters of rendered report. */
export declare const MAX_REPORT_MARKDOWN_CHARS = 20000;
/** The briefing digest rides in the same column as the report so every reader
 * (CLI list/status, daemon, UI, the dream prompt) keeps working, but it gets
 * its OWN budget: the digest is appended after the report, so one shared cap
 * always cut the digest first and silently dropped the inbox/radar sections. */
export declare const MAX_BRIEFING_MARKDOWN_CHARS = 20000;
export declare const SURF_REPORT_DIGEST_SEPARATOR = "\n\n---\n\n";
/** Compose the stored run document from a report and its briefing digest. The
 * report is capped on its own budget BEFORE the digest is appended, so the
 * digest can never be the thing the report cap cuts. */
export declare function composeSurfReportMarkdown(reportMarkdown: string | null | undefined, briefingMarkdown: string | null | undefined): string;
export interface MetawebSurfRunStats {
    fetched: number;
    deepRead: number;
    savedToKb: number;
    knowledgePoints: number;
    liked: number;
    commented: number;
    answered: number;
    posted: number;
    challenged: number;
    inboxHandled: number;
    discoveredProtocols: number;
    /** Scheduled tasks created (surf→work handoff); ground truth from the session marker. */
    tasksScheduled: number;
}
export declare const emptySurfRunStats: () => MetawebSurfRunStats;
/** Whether the session produced any activity a consumer can verify.
 *
 * `fetched` is deliberately excluded: the briefing sets it, so it can never
 * prove the session ran. The rest are the counters the session reports — for a
 * truncated run they come from host receipts (see the watchdog / no-LLM paths
 * in cli/runtime.ts), which is exactly the evidence that its work was real. */
export declare function surfSessionDidSomething(stats: MetawebSurfRunStats): boolean;
export interface MetawebSurfRunRecord {
    id: string;
    trigger: MetawebSurfTrigger;
    status: MetawebSurfRunStatus;
    stats: MetawebSurfRunStats;
    reportMarkdown: string | null;
    reportJson: string | null;
    error: string | null;
    /**
     * Structured failure (stage/code/stack/context) for failed runs; null on
     * running/done rows and on records written before the taxonomy existed.
     */
    failure: SurfRunFailure | null;
    startedAt: string;
    finishedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface MetawebSurfProtocolState {
    protocolKey: string;
    /** Unix seconds of the newest chain item seen last run; null = never surfed. */
    lastSeenTs: number | null;
    lastPinId: string | null;
    /**
     * Opaque surf-reads R1 cursor of the unscanned backlog remainder (the
     * window's first page reported hasMore, or a backlog page still in
     * progress). null = no registered debt. Stored and forwarded verbatim,
     * never parsed client-side.
     */
    backlogCursor: string | null;
    updatedAt: string;
}
declare function isoNow(nowMs: number): string;
export interface MetawebSurfStore {
    createRun(input: {
        id: string;
        trigger: MetawebSurfTrigger;
        nowIso: string;
    }): Promise<MetawebSurfRunRecord>;
    finishRun(id: string, outcome: {
        status: Exclude<MetawebSurfRunStatus, 'running'>;
        stats: MetawebSurfRunStats;
        reportMarkdown?: string | null;
        reportJson?: string | null;
        error?: string | null;
        failure?: SurfRunFailure | null;
        finishedAtIso: string;
    }): Promise<boolean>;
    getRun(id: string): Promise<MetawebSurfRunRecord | null>;
    /** Newest first, for the UI report list. */
    listRuns(limit?: number): Promise<MetawebSurfRunRecord[]>;
    /** Latest finished run regardless of trigger — the "surfed within 20h" check. */
    getLatestFinishedRun(): Promise<MetawebSurfRunRecord | null>;
    /** True when any run is currently in the running state. */
    hasRunningRun(): Promise<boolean>;
    /**
     * Crash recovery: runs left 'running' by a killed process become failed —
     * a surf run has no queue to rejoin, the next trigger starts a fresh one.
     */
    failStaleRunningRuns(input: {
        error: string;
        nowIso: string;
        excludeId?: string;
    }): Promise<number>;
    getProtocolState(protocolKey: string): Promise<MetawebSurfProtocolState | null>;
    listProtocolStates(): Promise<MetawebSurfProtocolState[]>;
    /**
     * Advance the watermark after a successful run; never rewinds.
     *
     * `lastSeenTs: null` leaves the watermark untouched (backlog pages never
     * advance it — their items are older than the watermark).
     *
     * `backlogCursor`: undefined leaves the stored cursor untouched, null
     * CLEARS it (backlog debt drained), a string STORES it verbatim (opaque
     * server token — the store never parses or validates it).
     */
    advanceProtocolState(protocolKey: string, input: {
        lastSeenTs: number | null;
        lastPinId?: string | null;
        nowIso: string;
        backlogCursor?: string | null;
    }): Promise<void>;
    getSeenAction(pinId: string): Promise<MetawebSurfSeenAction | null>;
    /** Record that the bot saw a pin, upgrading to the strongest action so far. */
    markSeen(pinId: string, action: MetawebSurfSeenAction, nowIso: string): Promise<void>;
    /** Batch variant of markSeen: one queued read-modify-write for a whole run's ledger writes. */
    markSeenBatch(entries: Array<{
        pinId: string;
        action: MetawebSurfSeenAction;
    }>, nowIso: string): Promise<void>;
    /** Return the subset of candidate pin ids the bot has never seen. */
    filterUnseen(pinIds: string[]): Promise<string[]>;
    /** Bound ledger growth: drop entries older than the retention window, then (if still oversized) the oldest entries beyond the cap. */
    pruneSeenPins(nowIso: string): Promise<void>;
}
/** Create the per-bot surf store bound to `paths.surf*` (`.runtime/surf/`). */
export declare function createMetawebSurfStore(paths: MetabotPaths): MetawebSurfStore;
export { isoNow };
