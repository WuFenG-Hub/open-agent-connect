/**
 * Long-term task advance SERVICE — the effect half. It builds the planner's
 * inputs out of stored data, asks `planAdvance` what to do, and applies the
 * bookkeeping the next pass depends on: one audit event per push, and the nudge
 * state that makes the throttle real across runs.
 *
 * What it deliberately does NOT do yet: deliver the push anywhere. The
 * reference escalates into a cowork session, and this repository has no such
 * source wired for long-term tasks; delivering into a channel that does not
 * exist would be untestable. Until that lands, a push is a durable, auditable
 * record — which is itself the useful half, and is what the driver will read.
 *
 * Two inputs the planner accepts are not derivable from the store yet and are
 * passed through as defaults, not invented: `failureStreak` (needs the attempt
 * tracker) and `waitUntil` (needs the wait setter). Callers can supply them via
 * `overrides` when those land.
 */
import type { LongTermStore } from './store.js';
import { type AdvanceCard, type AdvanceOptions, type AdvanceReport } from './advance.js';
export interface AdvanceRunResult extends AdvanceReport {
    /** How many pushes this run actually recorded. */
    applied: number;
}
export interface AdvanceOverrides {
    failureStreak?: Record<string, number>;
    waitUntil?: Record<string, string | null>;
    lastOwnerActivityAtMs?: Record<string, number | null>;
}
/** Build one planner card per task from stored rows. */
export declare function collectAdvanceCards(store: LongTermStore, overrides?: AdvanceOverrides): Promise<AdvanceCard[]>;
/**
 * Run one advance pass: plan, then apply. Applying is what makes the second run
 * different from the first — the nudge state is persisted before the next pass
 * reads it.
 */
export declare function runAdvance(store: LongTermStore, nowMs: number, options?: AdvanceOptions & {
    overrides?: AdvanceOverrides;
}): Promise<AdvanceRunResult>;
