"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectAdvanceCards = collectAdvanceCards;
exports.runAdvance = runAdvance;
const advance_js_1 = require("./advance.js");
/** Build one planner card per task from stored rows. */
async function collectAdvanceCards(store, overrides = {}) {
    const board = await store.getBoard();
    const cards = [];
    for (const card of board) {
        const events = await store.listEvents(card.task.id);
        const lastEventAtMs = events.length === 0
            ? 0
            : Math.max(...events.map((event) => Date.parse(event.at)).filter((at) => Number.isFinite(at)));
        const nudge = await store.getNudgeState(card.task.id);
        cards.push({
            task: card.task,
            currentSubtask: card.currentSubtask,
            lastEventAtMs: Number.isFinite(lastEventAtMs) ? lastEventAtMs : 0,
            failureStreak: overrides.failureStreak?.[card.task.id] ?? 0,
            recentEscalationsMs: events
                .filter((event) => event.kind === 'advance')
                .map((event) => Date.parse(event.at))
                .filter((at) => Number.isFinite(at)),
            lastNudgeAtMs: nudge?.lastNudgeAtMs ?? 0,
            lastNudgedEventAtMs: nudge?.lastNudgedEventAtMs ?? 0,
            lastOwnerActivityAtMs: overrides.lastOwnerActivityAtMs?.[card.task.id]
                ?? nudge?.lastOwnerActivityAtMs
                ?? null,
            waitUntil: overrides.waitUntil?.[card.task.id] ?? null,
        });
    }
    return cards;
}
/**
 * Run one advance pass: plan, then apply. Applying is what makes the second run
 * different from the first — the nudge state is persisted before the next pass
 * reads it.
 */
async function runAdvance(store, nowMs, options = {}) {
    const cards = await collectAdvanceCards(store, options.overrides ?? {});
    const report = (0, advance_js_1.planAdvance)(cards, nowMs, options);
    const nowIso = new Date(nowMs).toISOString();
    let applied = 0;
    for (const decision of report.decisions) {
        const card = cards.find((entry) => entry.task.id === decision.taskId);
        if (!card)
            continue;
        await store.addEvent({
            taskId: decision.taskId,
            subtaskId: card.currentSubtask?.id ?? null,
            kind: 'advance',
            actor: 'system',
            detail: decision.reasons.join('; '),
            at: nowIso,
        });
        // The anchor moves WITH our own bookkeeping event. Recording a push moves
        // the journal, and a throttle that lifts on its own footnote would never
        // hold — the reference states the same rule for its rebind note ("the
        // rebind's own journal note is bookkeeping, not new information").
        const after = await store.listEvents(decision.taskId);
        const anchorAtMs = after.reduce((newest, event) => {
            const at = Date.parse(event.at);
            return Number.isFinite(at) && at > newest ? at : newest;
        }, 0);
        await store.setNudgeState(decision.taskId, {
            lastNudgeAtMs: nowMs,
            lastNudgedEventAtMs: anchorAtMs,
            lastOwnerActivityAtMs: card.lastOwnerActivityAtMs,
        });
        applied += 1;
    }
    return { ...report, applied };
}
