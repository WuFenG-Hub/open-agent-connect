import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveCommandHelpSpec, ROOT_COMMAND_HELP } = require('../../dist/cli/commandHelp.js');

/**
 * Every command the CLI dispatches must also resolve in the help registry.
 *
 * These are two separate lists: `src/cli/main.ts` holds the dispatch switch,
 * and `src/cli/commandHelp.ts` holds the specs. The CLI answers
 * `resolveCommandHelpSpec` FIRST, so a command wired into the switch but
 * missing from the registry is rejected with `unknown_command` — and, because
 * the root list drives `metabot --help`, it is also undiscoverable.
 *
 * `metabot longtask --help` hit exactly that: the port wired dispatch and a
 * test that called the command layer directly, so nothing covered the real
 * entry point and the gap shipped.
 */

function dispatchedCommands() {
  const source = readFileSync(new URL('../../src/cli/main.ts', import.meta.url), 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/case '([a-z0-9-]+)':/g)) names.add(match[1]);
  return [...names].sort();
}

test('every dispatched command resolves in the help registry', () => {
  const missing = dispatchedCommands().filter((name) => !resolveCommandHelpSpec([name]));
  assert.deepEqual(missing, [], `commands with no help spec (their --help answers unknown_command): ${missing.join(', ')}`);
});

test('every dispatched command is listed in the root help', () => {
  const listed = new Set((ROOT_COMMAND_HELP.subcommands ?? []).map((entry) => entry.name));
  const missing = dispatchedCommands().filter((name) => !listed.has(name) && !['help', 'version'].includes(name));
  assert.deepEqual(missing, [], `commands hidden from "metabot --help": ${missing.join(', ')}`);
});

test('longtask resolves with its subcommands', () => {
  const spec = resolveCommandHelpSpec(['longtask']);
  assert.ok(spec, 'longtask must resolve');
  assert.equal(spec.commandPath.join(' '), 'longtask');
  const names = (spec.subcommands ?? []).map((s) => s.name);
  for (const sub of ['list', 'create', 'show', 'board', 'advance', 'add-subtask', 'set-status']) {
    assert.ok(names.includes(sub), `missing help for subcommand: ${sub}`);
  }
});
