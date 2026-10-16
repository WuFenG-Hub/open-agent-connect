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
export const LONGTERM_ADVANCE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MAX_ESCALATIONS_PER_RUN = 2;
export const DEFAULT_NUDGE_THROTTLE_MS = 30 * 60_000;
export const DEFAULT_WAITING_OWNER_REMINDER_MS = 2 * 3_600_000;
export const DEFAULT_EXTERNAL_REMINDER_MS = 4 * 3_600_000;
export const DEFAULT_FAILURE_STREAK_THRESHOLD = 2;
export const CONVERGENCE_CHURN_LIMIT = 3;
export const CONVERGENCE_CHURN_WINDOW_MS = 2 * 3_600_000;

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
export function collectAdvanceReasons(
  card: AdvanceCard,
  nowMs: number,
  options: AdvanceOptions = {},
): string[] {
  const waitingOwnerReminderMs = options.waitingOwnerReminderMs ?? DEFAULT_WAITING_OWNER_REMINDER_MS;
  const externalReminderMs = options.externalReminderMs ?? DEFAULT_EXTERNAL_REMINDER_MS;
  const failureStreakThreshold = options.failureStreakThreshold ?? DEFAULT_FAILURE_STREAK_THRESHOLD;
  const advanceIntervalMs = options.advanceIntervalMs ?? LONGTERM_ADVANCE_INTERVAL_MS;
  const reasons: string[] = [];
  const status = card.currentSubtask?.status ?? null;

  // A sub-project that keeps failing is a work turn, not an owner turn.
  if (card.failureStreak >= failureStreakThreshold) reasons.push('sub-project failing');

  if (status === 'waiting_owner') {
    const sinceOwner = card.lastOwnerActivityAtMs === null
      ? card.lastEventAtMs
      : card.lastOwnerActivityAtMs;
    // Quiet is measured from the END of the discussion, not the last journal line.
    if (nowMs - sinceOwner >= waitingOwnerReminderMs) reasons.push('owner decision still pending');
  }
  if (status === 'waiting_external') {
    const due = card.waitUntil !== null && Date.parse(card.waitUntil) <= nowMs;
    if (due) reasons.push('external wait expired');
    else if (nowMs - card.lastEventAtMs >= externalReminderMs) reasons.push('external wait still pending');
  }

  // A loop that keeps escalating without converging is brought to the owner.
  const inWindow = card.recentEscalationsMs.filter((at) => nowMs - at <= CONVERGENCE_CHURN_WINDOW_MS);
  if (inWindow.length >= CONVERGENCE_CHURN_LIMIT) reasons.push('convergence churn');

  if (reasons.length === 0 && status !== null
    && nowMs - card.lastEventAtMs >= advanceIntervalMs) {
    reasons.push('advance due');
  }
  return reasons;
}

/**
 * Plan one advance pass: which tasks to push, why, and which were skipped and
 * why. Order matters — the budget is spent on the stalest tasks first.
 */
export function planAdvance(
  cards: AdvanceCard[],
  nowMs: number,
  options: AdvanceOptions = {},
): AdvanceReport {
  const maxDecisions = options.maxDecisionsPerRun ?? DEFAULT_MAX_ESCALATIONS_PER_RUN;
  const nudgeThrottleMs = options.nudgeThrottleMs ?? DEFAULT_NUDGE_THROTTLE_MS;
  const report: AdvanceReport = { checkedTasks: 0, decisions: [], skipped: [] };

  const active = cards
    .filter((card) => card.task.stage === 'active')
    .sort((left, right) => left.task.updatedAt.localeCompare(right.task.updatedAt));

  for (const card of active) {
    // Budget first, exactly like the reference: a task past the budget is not
    // even checked.
    if (report.decisions.length >= maxDecisions) {
      report.skipped.push({ taskId: card.task.id, reason: 'run escalation budget reached' });
      continue;
    }
    report.checkedTasks += 1;
    if (!card.currentSubtask) {
      report.skipped.push({ taskId: card.task.id, reason: 'no open sub-project' });
      continue;
    }
    const reasons = collectAdvanceReasons(card, nowMs, options);
    if (reasons.length === 0) {
      report.skipped.push({
        taskId: card.task.id,
        reason: `current sub-project is ${card.currentSubtask.status}, nothing due`,
      });
      continue;
    }
    // The noise throttle: one nudge per task per window while the journal has
    // not moved. An expired timed wait is a clock condition, not noise.
    const waitDue = card.currentSubtask.status === 'waiting_external'
      && card.waitUntil !== null
      && Date.parse(card.waitUntil) <= nowMs;
    const journalMoved = card.lastNudgedEventAtMs !== card.lastEventAtMs;
    const throttled = nowMs - card.lastNudgeAtMs < nudgeThrottleMs && !journalMoved && !waitDue;
    if (throttled) {
      report.skipped.push({
        taskId: card.task.id,
        reason: 'throttled: nudged recently and the journal has not moved',
      });
      continue;
    }
    report.decisions.push({ taskId: card.task.id, reasons });
  }
  return report;
}
