/**
 * Long-term task advance planning — the DECISION half, ported from the IDBots
 * `longTermAdvanceService`. This module is pure: it takes the board as data plus
 * an explicit `now`, and returns what should happen. It performs no IO and
 * applies no side effect, so every rule below is verifiable on its own.
 *
 * Ported from the reference:
 *  - only `active` tasks are looked at, least-recently-active first, so a stale
 *    task gets the push slot before a busy one;
 *  - a run-wide escalation budget, checked BEFORE each task;
 *  - the noise throttle: a task nudged inside the window is skipped while the
 *    journal has not moved, but a clock condition (an expired timed wait) is not
 *    noise and bypasses it;
 *  - the rule set the reference's constants define (owner-wait reminder,
 *    external reminder, failure streak, convergence churn).
 *
 * NOT ported yet, and deliberately absent rather than stubbed: the reference's
 * owner-venue rebinding, its cross-session engagement window and its supervision
 * signal all read `cowork_sessions`, which does not exist in this repository.
 * Inventing that data here would make the rules untestable; the wiring lands
 * with the tool surface, where a real session source exists.
 */
import type { LongTermSubtask, LongTermTask } from './types.js';
/** Advance cadence for the driver that will call this planner. */
export declare const LONGTERM_ADVANCE_INTERVAL_MS: number;
export declare const DEFAULT_MAX_ESCALATIONS_PER_RUN = 2;
export declare const DEFAULT_NUDGE_THROTTLE_MS: number;
export declare const DEFAULT_WAITING_OWNER_REMINDER_MS: number;
export declare const DEFAULT_EXTERNAL_REMINDER_MS: number;
export declare const DEFAULT_FAILURE_STREAK_THRESHOLD = 2;
export declare const CONVERGENCE_CHURN_LIMIT = 3;
export declare const CONVERGENCE_CHURN_WINDOW_MS: number;
/** One task's planner input. Everything here is data, not a store handle. */
export interface AdvanceCard {
    task: LongTermTask;
    /** The sub-task the board currently focuses on, or null when none is open. */
    currentSubtask: LongTermSubtask | null;
    /** Epoch ms of the newest journal event for this task (0 when none). */
    lastEventAtMs: number;
    /** Consecutive failed attempts at the current sub-task. */
    failureStreak: number;
    /** Escalation timestamps inside the churn window. */
    recentEscalationsMs: number[];
    /** Persisted nudge bookkeeping: when we last nudged… */
    lastNudgeAtMs: number;
    /** …and the journal event that had already been seen at that point. */
    lastNudgedEventAtMs: number;
    /** Epoch ms the owner was last seen engaging with this task, if ever. */
    lastOwnerActivityAtMs: number | null;
    /** An explicit timed wait (`waiting_external` only), ISO-8601 or null. */
    waitUntil: string | null;
}
export interface AdvanceDecision {
    taskId: string;
    /** Why this task is being pushed, in the reference's own vocabulary. */
    reasons: string[];
}
export interface AdvanceSkip {
    taskId: string;
    reason: string;
}
export interface AdvanceReport {
    checkedTasks: number;
    decisions: AdvanceDecision[];
    skipped: AdvanceSkip[];
}
export interface AdvanceOptions {
    maxDecisionsPerRun?: number;
    nudgeThrottleMs?: number;
    waitingOwnerReminderMs?: number;
    externalReminderMs?: number;
    failureStreakThreshold?: number;
    advanceIntervalMs?: number;
}
/** The reference's rule set, in the order it collects them. */
export declare function collectAdvanceReasons(card: AdvanceCard, nowMs: number, options?: AdvanceOptions): string[];
/**
 * Plan one advance pass: which tasks to push, why, and which were skipped and
 * why. Order matters — the budget is spent on the stalest tasks first.
 */
export declare function planAdvance(cards: AdvanceCard[], nowMs: number, options?: AdvanceOptions): AdvanceReport;
