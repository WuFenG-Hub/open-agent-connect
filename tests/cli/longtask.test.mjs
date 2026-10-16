import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLongTaskCommand, LONG_TASK_SUBCOMMANDS } = require('../../dist/cli/commands/longtask.js');

/** The command layer: flag parsing and dispatch over the injected handlers. */

const contextWith = (longtask) => ({ dependencies: { longtask } });
const ok = (data) => ({ ok: true, state: 'success', data });

test('longtask: create passes the parsed flags through', async () => {
  const calls = [];
  const result = await runLongTaskCommand(
    ['create', '--id', 't1', '--title', 'long haul', '--goal', 'g', '--from', 'bot'],
    contextWith({ create: async (input) => { calls.push(input); return ok(input); } }),
  );
  assert.equal(result.state, 'success');
  assert.deepEqual(calls, [{ from: 'bot', id: 't1', title: 'long haul', goal: 'g' }]);
});

test('longtask: a missing required flag is refused before any handler runs', async () => {
  let called = 0;
  const context = contextWith({ create: async () => { called += 1; return ok({}); } });
  const noId = await runLongTaskCommand(['create', '--title', 'T'], context);
  assert.equal(noId.ok, false);
  assert.equal(noId.code, 'missing_flag');
  assert.match(noId.message, /--id/);
  const noTitle = await runLongTaskCommand(['create', '--id', 't1'], context);
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.message, /--title/);
  assert.equal(called, 0, 'a refused command never reaches the handler');
});

test('longtask: a non-integer ordinal is refused, depends-on is split', async () => {
  const calls = [];
  const context = contextWith({ addSubtask: async (input) => { calls.push(input); return ok(input); } });
  const bad = await runLongTaskCommand(
    ['add-subtask', '--id', 't1', '--subtask', 's1', '--title', 'x', '--ordinal', 'abc'], context);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid_flag_value');
  assert.match(bad.message, /--ordinal/);
  assert.equal(calls.length, 0);

  const good = await runLongTaskCommand(
    ['add-subtask', '--id', 't1', '--subtask', 's1', '--title', 'x', '--ordinal', '2', '--depends-on', 'a, b'],
    context);
  assert.equal(good.state, 'success');
  assert.deepEqual(calls[0].dependsOn, ['a', 'b']);
  assert.equal(calls[0].ordinal, 2);
});

test('longtask: an unknown verb, an unwired verb and a missing surface are all reported', async () => {
  const unknown = await runLongTaskCommand(['nope'], contextWith({}));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown_command');

  const unwired = await runLongTaskCommand(['advance'], contextWith({}));
  assert.equal(unwired.ok, false);
  assert.equal(unwired.code, 'not_implemented');

  const none = await runLongTaskCommand(['list'], { dependencies: {} });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'not_implemented');

  assert.ok(LONG_TASK_SUBCOMMANDS.includes('advance'));
});
