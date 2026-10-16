import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  deriveColumn,
  deriveProgress,
  deriveCurrentSubtask,
} = require('../../dist/core/longtask/derive.js');
const { LONG_TERM_COLUMN_ORDER } = require('../../dist/core/longtask/types.js');

/** Long-term task board derivations — ported verbatim from the IDBots store. */

const sub = (id, ordinal, status, over = {}) => ({
  id, ordinal, title: id, status, dependsOn: [], expectedMinutes: null, ...over,
});

test('deriveColumn: stage wins, then the current sub-task, and cancelled is off the board', () => {
  // Stage-terminal columns ignore the sub-task entirely.
  assert.equal(deriveColumn('defining', null), 'defining');
  assert.equal(deriveColumn('paused', 'in_progress'), 'paused');
  assert.equal(deriveColumn('done', 'pending'), 'done');
  // Cancelled tasks stay in the data but have NO column.
  assert.equal(deriveColumn('cancelled', 'waiting_owner'), null);

  // An active task takes its column from the current sub-task's status.
  assert.equal(deriveColumn('active', 'waiting_owner'), 'waiting_owner');
  assert.equal(deriveColumn('active', 'waiting_external'), 'waiting_external');
  assert.equal(deriveColumn('active', 'in_progress'), 'in_progress');
  assert.equal(deriveColumn('active', 'pending'), 'in_progress');
  assert.equal(deriveColumn('active', null), 'in_progress');
});

test('deriveProgress: skipped sub-tasks leave both numerator and denominator', () => {
  assert.deepEqual(deriveProgress([]), { accepted: 0, total: 0, percent: 0 });

  const mixed = [
    sub('a', 1, 'accepted'),
    sub('b', 2, 'in_progress'),
    sub('c', 3, 'skipped'),
  ];
  // 1 of 2 (the skipped one is gone from both sides), not 1 of 3.
  assert.deepEqual(deriveProgress(mixed), { accepted: 1, total: 2, percent: 50 });

  // Everything skipped → nothing left to measure, and no divide-by-zero.
  assert.deepEqual(
    deriveProgress([sub('a', 1, 'skipped'), sub('b', 2, 'skipped')]),
    { accepted: 0, total: 0, percent: 0 },
  );

  // Rounding, not truncation.
  assert.deepEqual(
    deriveProgress([sub('a', 1, 'accepted'), sub('b', 2, 'pending'), sub('c', 3, 'pending')]),
    { accepted: 1, total: 3, percent: 33 },
  );
  assert.deepEqual(
    deriveProgress([sub('a', 1, 'accepted'), sub('b', 2, 'accepted'), sub('c', 3, 'pending')]),
    { accepted: 2, total: 3, percent: 67 },
  );
});

test('deriveCurrentSubtask: pinned wins only while open, else lowest unblocked ordinal', () => {
  const subtasks = [
    sub('s3', 3, 'pending', { dependsOn: ['s1'] }),
    sub('s1', 1, 'accepted'),
    sub('s2', 2, 'pending', { dependsOn: ['s9'] }),
  ];
  // s1 is accepted → not open. Open, by ordinal: s2 (blocked by s9), s3 (unblocked).
  // The first *unblocked* one wins, even though s2 has the lower ordinal.
  assert.equal(deriveCurrentSubtask(null, subtasks).id, 's3');

  // A pin only wins while it is still open.
  assert.equal(deriveCurrentSubtask('s2', subtasks).id, 's2', 'a pinned open sub-task wins');
  assert.equal(deriveCurrentSubtask('s1', subtasks).id, 's3', 'an accepted pin is ignored');

  // Nothing open → null, regardless of a pin.
  assert.equal(deriveCurrentSubtask('s1', [sub('s1', 1, 'accepted')]), null);
  assert.equal(deriveCurrentSubtask(null, [sub('s1', 1, 'skipped')]), null);
  assert.equal(deriveCurrentSubtask('s1', []), null);
});

test('deriveCurrentSubtask: a fully blocked set still yields a card (never blank)', () => {
  const blocked = [
    sub('b', 2, 'pending', { dependsOn: ['missing'] }),
    sub('a', 1, 'pending', { dependsOn: ['missing'] }),
  ];
  assert.equal(deriveCurrentSubtask(null, blocked).id, 'a', 'falls back to the lowest ordinal');
});

test('column order is the ported contract', () => {
  assert.deepEqual(LONG_TERM_COLUMN_ORDER, [
    'waiting_owner', 'in_progress', 'waiting_external', 'defining', 'paused', 'done',
  ]);
});
