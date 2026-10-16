"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONVERGENCE_CHURN_WINDOW_MS = exports.CONVERGENCE_CHURN_LIMIT = exports.DEFAULT_FAILURE_STREAK_THRESHOLD = exports.DEFAULT_EXTERNAL_REMINDER_MS = exports.DEFAULT_WAITING_OWNER_REMINDER_MS = exports.DEFAULT_NUDGE_THROTTLE_MS = exports.DEFAULT_MAX_ESCALATIONS_PER_RUN = exports.LONGTERM_ADVANCE_INTERVAL_MS = void 0;
exports.collectAdvanceReasons = collectAdvanceReasons;
exports.planAdvance = planAdvance;
/** Advance cadence for the driver that will call this planner. */
exports.LONGTERM_ADVANCE_INTERVAL_MS = 5 * 60_000;
exports.DEFAULT_MAX_ESCALATIONS_PER_RUN = 2;
exports.DEFAULT_NUDGE_THROTTLE_MS = 30 * 60_000;
exports.DEFAULT_WAITING_OWNER_REMINDER_MS = 2 * 3_600_000;
exports.DEFAULT_EXTERNAL_REMINDER_MS = 4 * 3_600_000;
exports.DEFAULT_FAILURE_STREAK_THRESHOLD = 2;
exports.CONVERGENCE_CHURN_LIMIT = 3;
exports.CONVERGENCE_CHURN_WINDOW_MS = 2 * 3_600_000;
/** The reference's rule set, in the order it collects them. */
function collectAdvanceReasons(card, nowMs, options = {}) {
    const waitingOwnerReminderMs = options.waitingOwnerReminderMs ?? exports.DEFAULT_WAITING_OWNER_REMINDER_MS;
    const externalReminderMs = options.externalReminderMs ?? exports.DEFAULT_EXTERNAL_REMINDER_MS;
    const failureStreakThreshold = options.failureStreakThreshold ?? exports.DEFAULT_FAILURE_STREAK_THRESHOLD;
    const advanceIntervalMs = options.advanceIntervalMs ?? exports.LONGTERM_ADVANCE_INTERVAL_MS;
    const reasons = [];
    const status = card.currentSubtask?.status ?? null;
    // A sub-project that keeps failing is a work turn, not an owner turn.
    if (card.failureStreak >= failureStreakThreshold)
        reasons.push('sub-project failing');
    if (status === 'waiting_owner') {
        const sinceOwner = card.lastOwnerActivityAtMs === null
            ? card.lastEventAtMs
            : card.lastOwnerActivityAtMs;
        // Quiet is measured from the END of the discussion, not the last journal line.
        if (nowMs - sinceOwner >= waitingOwnerReminderMs)
            reasons.push('owner decision still pending');
    }
    if (status === 'waiting_external') {
        const due = card.waitUntil !== null && Date.parse(card.waitUntil) <= nowMs;
        if (due)
            reasons.push('external wait expired');
        else if (nowMs - card.lastEventAtMs >= externalReminderMs)
            reasons.push('external wait still pending');
    }
    // A loop that keeps escalating without converging is brought to the owner.
    const inWindow = card.recentEscalationsMs.filter((at) => nowMs - at <= exports.CONVERGENCE_CHURN_WINDOW_MS);
    if (inWindow.length >= exports.CONVERGENCE_CHURN_LIMIT)
        reasons.push('convergence churn');
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
function planAdvance(cards, nowMs, options = {}) {
    const maxDecisions = options.maxDecisionsPerRun ?? exports.DEFAULT_MAX_ESCALATIONS_PER_RUN;
    const nudgeThrottleMs = options.nudgeThrottleMs ?? exports.DEFAULT_NUDGE_THROTTLE_MS;
    const report = { checkedTasks: 0, decisions: [], skipped: [] };
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
