import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import { mkdtempTempRootSync } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { createLongTermStore } = require('../../dist/core/longtask/store.js');
const { collectAdvanceCards, runAdvance } = require('../../dist/core/longtask/service.js');

const T0 = Date.parse('2026-10-16T00:00:00.000Z');
const HOUR = 3_600_000;

const pathsFor = () => {
  const root = path.join(mkdtempTempRootSync('metabot-longtask-svc-'), 'longterm');
  return {
    root,
    tasksPath: path.join(root, 'tasks.json'),
    subtasksPath: path.join(root, 'subtasks.json'),
    eventsPath: path.join(root, 'events.json'),
    nudgeStatePath: path.join(root, 'nudge-state.json'),
  };
};

/** A long-running task with one open sub-project, ready to be pushed. */
async function seed(store) {
  await store.createTask({ id: 't1', title: 'long haul', stage: 'active', nowIso: new Date(T0).toISOString() });
  await store.addSubtask({ taskId: 't1', id: 's1', ordinal: 1, title: 'first step', status: 'in_progress' });
}

test('collectAdvanceCards builds planner input from stored rows', async () => {
  const store = createLongTermStore(pathsFor());
  await seed(store);
  const cards = await collectAdvanceCards(store);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].task.id, 't1');
  assert.equal(cards[0].currentSubtask.id, 's1');
  assert.equal(cards[0].lastNudgeAtMs, 0, 'no nudge yet');
  assert.deepEqual(cards[0].recentEscalationsMs, [], 'nothing escalated yet');
});

test('runAdvance records a push and persists the nudge state', async () => {
  const store = createLongTermStore(pathsFor());
  await seed(store);
  const now = T0 + HOUR;
  const result = await runAdvance(store, now);

  assert.equal(result.applied, 1);
  assert.deepEqual(result.decisions, [{ taskId: 't1', reasons: ['advance due'] }]);

  const events = await store.listEvents('t1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'advance');
  assert.equal(events[0].detail, 'advance due');
  assert.equal(events[0].subtaskId, 's1');

  const nudge = await store.getNudgeState('t1');
  assert.equal(nudge.lastNudgeAtMs, now);
  assert.equal(nudge.lastNudgedEventAtMs, now, 'the anchor includes our own bookkeeping event');
});

test('runAdvance twice: the second pass is throttled, not repeated', async () => {
  const store = createLongTermStore(pathsFor());
  await seed(store);
  const first = await runAdvance(store, T0 + HOUR);
  assert.equal(first.applied, 1);

  // The throttle is only reachable when something IS due but a nudge already
  // happened inside the window: at +1 minute nothing is due at all, and the
  // planner reports that first (same order as the reference). So step past the
  // advance interval but stay inside the 30-minute throttle.
  const second = await runAdvance(store, T0 + HOUR + 6 * 60_000);
  assert.deepEqual(second.decisions, [], 'a push is not repeated every pass');
  assert.equal(second.applied, 0);
  assert.equal(second.skipped[0].reason,
    'throttled: nudged recently and the journal has not moved');
  assert.equal((await store.listEvents('t1')).length, 1, 'no second event was written');

  // Still nothing due one minute in — but for the other reason.
  const tooEarly = await runAdvance(store, T0 + HOUR + 60_000);
  assert.equal(tooEarly.skipped[0].reason, 'current sub-project is in_progress, nothing due');

  // Past the throttle window, and with the journal still unmoved, a plain
  // advance is due again.
  const third = await runAdvance(store, T0 + HOUR + 31 * 60_000);
  assert.deepEqual(third.decisions, [{ taskId: 't1', reasons: ['advance due'] }]);
  assert.equal(third.applied, 1);
});

test('runAdvance ignores tasks that are not active', async () => {
  const store = createLongTermStore(pathsFor());
  await store.createTask({ id: 'd', title: 'draft', stage: 'defining', nowIso: new Date(T0).toISOString() });
  await store.addSubtask({ taskId: 'd', id: 's1', ordinal: 1, title: 'x' });
  const result = await runAdvance(store, T0 + 10 * HOUR);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.checkedTasks, 0);
  assert.equal((await store.listEvents('d')).length, 0);
});

test('runAdvance honours the run budget and reports the tasks it skipped', async () => {
  const store = createLongTermStore(pathsFor());
  await store.createTask({ id: 'a', title: 'A', stage: 'active', nowIso: new Date(T0).toISOString() });
  await store.createTask({ id: 'b', title: 'B', stage: 'active', nowIso: new Date(T0 + 1000).toISOString() });
  await store.addSubtask({ taskId: 'a', id: 's', ordinal: 1, title: 'x' });
  await store.addSubtask({ taskId: 'b', id: 's', ordinal: 1, title: 'x' });

  const result = await runAdvance(store, T0 + HOUR, { maxDecisionsPerRun: 1 });
  assert.equal(result.applied, 1);
  assert.deepEqual(result.decisions.map((d) => d.taskId), ['a'], 'the staler task wins the slot');
  assert.deepEqual(result.skipped, [{ taskId: 'b', reason: 'run escalation budget reached' }]);
});
