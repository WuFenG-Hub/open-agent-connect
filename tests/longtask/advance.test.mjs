import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planAdvance,
  collectAdvanceReasons,
  LONGTERM_ADVANCE_INTERVAL_MS,
  CONVERGENCE_CHURN_LIMIT,
} = require('../../dist/core/longtask/advance.js');

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-16T00:00:00.000Z');

const card = (over = {}) => ({
  task: {
    id: 't1', title: 'T', goal: '', stage: 'active', currentSubtaskId: null,
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
    ...(over.task ?? {}),
  },
  currentSubtask: 'currentSubtask' in over
    ? over.currentSubtask
    : { id: 's1', ordinal: 1, title: 's1', status: 'in_progress', dependsOn: [], expectedMinutes: null },
  lastEventAtMs: 'lastEventAtMs' in over ? over.lastEventAtMs : T0,
  failureStreak: over.failureStreak ?? 0,
  recentEscalationsMs: over.recentEscalationsMs ?? [],
  lastNudgeAtMs: over.lastNudgeAtMs ?? 0,
  lastNudgedEventAtMs: over.lastNudgedEventAtMs ?? 0,
  lastOwnerActivityAtMs: 'lastOwnerActivityAtMs' in over ? over.lastOwnerActivityAtMs : null,
  waitUntil: 'waitUntil' in over ? over.waitUntil : null,
});

test('planAdvance: only active tasks are considered', () => {
  const report = planAdvance([
    card({ task: { id: 'a', stage: 'defining' } }),
    card({ task: { id: 'b', stage: 'paused' } }),
    card({ task: { id: 'c', stage: 'done' } }),
    card({ task: { id: 'd', stage: 'cancelled' } }),
  ], T0 + 10 * HOUR);
  assert.equal(report.checkedTasks, 0);
  assert.deepEqual(report.decisions, []);
  assert.deepEqual(report.skipped, [], 'non-active tasks are not even reported as skipped');
});

test('planAdvance: the stalest task takes the push slot first', () => {
  const report = planAdvance([
    card({ task: { id: 'fresh', updatedAt: '2026-10-16T09:00:00.000Z' }, lastEventAtMs: T0 }),
    card({ task: { id: 'stale', updatedAt: '2026-10-15T00:00:00.000Z' }, lastEventAtMs: T0 }),
  ], T0 + 10 * HOUR, { maxDecisionsPerRun: 1 });
  assert.deepEqual(report.decisions.map((d) => d.taskId), ['stale']);
  assert.deepEqual(report.skipped, [{
    taskId: 'fresh', reason: 'run escalation budget reached',
  }]);
});

test('planAdvance: a task with no open sub-project and a quiet task are both skipped with reasons', () => {
  const report = planAdvance([
    card({ task: { id: 'empty' }, currentSubtask: null }),
    card({ task: { id: 'quiet' }, lastEventAtMs: T0 }),
  ], T0 + 1000);
  assert.deepEqual(report.decisions, []);
  assert.deepEqual(report.skipped, [
    { taskId: 'empty', reason: 'no open sub-project' },
    { taskId: 'quiet', reason: 'current sub-project is in_progress, nothing due' },
  ]);
});

test('collectAdvanceReasons: the owner-wait reminder measures quiet from the last owner activity', () => {
  const waiting = { status: 'waiting_owner' };
  // The journal moved 10 minutes ago, but the OWNER has been quiet for 3 hours.
  const reasons = collectAdvanceReasons(card({
    currentSubtask: { id: 's1', ordinal: 1, title: 'x', status: waiting.status, dependsOn: [], expectedMinutes: null },
    lastEventAtMs: T0 + 3 * HOUR - 10 * 60_000,
    lastOwnerActivityAtMs: T0,
  }), T0 + 3 * HOUR);
  assert.deepEqual(reasons, ['owner decision still pending']);

  // Still inside the window → nothing due.
  assert.deepEqual(collectAdvanceReasons(card({
    currentSubtask: { id: 's1', ordinal: 1, title: 'x', status: 'waiting_owner', dependsOn: [], expectedMinutes: null },
    lastEventAtMs: T0 + 1 * HOUR,
    lastOwnerActivityAtMs: T0 + 1 * HOUR,
  }), T0 + 1 * HOUR + 1000), []);
});

test('collectAdvanceReasons: an expired timed wait is due, an unexpired one nags on its own clock', () => {
  const status = 'waiting_external';
  const due = collectAdvanceReasons(card({
    currentSubtask: { id: 's1', ordinal: 1, title: 'x', status, dependsOn: [], expectedMinutes: null },
    lastEventAtMs: T0, waitUntil: '2026-10-16T04:00:00.000Z',
  }), T0 + 5 * HOUR);
  assert.ok(due.includes('external wait expired'));

  const nag = collectAdvanceReasons(card({
    currentSubtask: { id: 's1', ordinal: 1, title: 'x', status, dependsOn: [], expectedMinutes: null },
    lastEventAtMs: T0, waitUntil: '2026-10-17T00:00:00.000Z',
  }), T0 + 5 * HOUR);
  assert.deepEqual(nag, ['external wait still pending']);
});

test('collectAdvanceReasons: a failing sub-project and a churning loop are both reported', () => {
  assert.deepEqual(collectAdvanceReasons(card({ failureStreak: 2, lastEventAtMs: T0 }), T0 + 1000),
    ['sub-project failing']);
  assert.deepEqual(
    collectAdvanceReasons(card({ recentEscalationsMs: [T0, T0 + HOUR, T0 + 2 * HOUR], lastEventAtMs: T0 }), T0 + 2 * HOUR),
    ['convergence churn'],
  );
  // Escalations outside the churn window do not count.
  assert.deepEqual(
    collectAdvanceReasons(card({
      recentEscalationsMs: [T0 - 5 * HOUR, T0 - 4 * HOUR, T0 - 3 * HOUR], lastEventAtMs: T0,
    }), T0 + 1000),
    [],
  );
  assert.equal(CONVERGENCE_CHURN_LIMIT, 3);
});

test('planAdvance: a plain advance is due only after the interval', () => {
  const quiet = card({ lastEventAtMs: T0 });
  const early = planAdvance([quiet], T0 + LONGTERM_ADVANCE_INTERVAL_MS - 1);
  assert.deepEqual(early.decisions, [], 'inside the interval nothing is due');
  const due = planAdvance([quiet], T0 + LONGTERM_ADVANCE_INTERVAL_MS);
  assert.deepEqual(due.decisions, [{ taskId: 't1', reasons: ['advance due'] }]);
});

test('planAdvance: the noise throttle holds until the journal moves or a wait expires', () => {
  const nudged = card({ lastEventAtMs: T0, lastNudgeAtMs: T0 + 10 * HOUR, lastNudgedEventAtMs: T0 });
  const now = T0 + 10 * HOUR + 60_000; // inside the 30-minute throttle window
  assert.deepEqual(planAdvance([nudged], now).decisions, []);
  assert.equal(planAdvance([nudged], now).skipped[0].reason,
    'throttled: nudged recently and the journal has not moved');

  // The journal moved → that is new information, so the throttle lifts. Note the
  // move must also be older than the advance interval: lifting the throttle is
  // not the same as something being due.

  const moved = { ...nudged, lastEventAtMs: T0 + 9 * HOUR };
  assert.equal(planAdvance([moved], now).decisions.length, 1);

  // An expired timed wait is a clock condition, not noise, so it lifts too.
  const waitDue = {
    ...nudged,
    currentSubtask: { id: 's1', ordinal: 1, title: 'x', status: 'waiting_external', dependsOn: [], expectedMinutes: null },
    waitUntil: '2026-10-16T05:00:00.000Z',
  };
  assert.ok(planAdvance([waitDue], T0 + 10 * HOUR + 60_000).decisions.length === 1);
});
