import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runCli } = require('../../dist/cli/main.js');
const { runGroupTaskCommand } = require('../../dist/cli/commands/grouptask.js');
const { pollTraceUntilComplete } = require('../../dist/cli/commands/pollTraceHelper.js');
const { commandSuccess } = require('../../dist/core/contracts/commandResult.js');

function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    context: {
      stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

test('metabot agents and agents --help list subcommands instead of unknown_command', async () => {
  const bare = capture();
  const bareCode = await runCli(['agents'], bare.context);
  const bareEnvelope = JSON.parse(bare.stdout.join(''));
  assert.equal(bareCode, 1);
  assert.equal(bareEnvelope.code, 'missing_subcommand');
  assert.match(bareEnvelope.message, /agents <status\|hooks>/);
  assert.match(bareEnvelope.message, /hooks install/);
  assert.equal(bareEnvelope.message.includes('Unknown command'), false);

  const help = capture();
  const helpCode = await runCli(['agents', '--help'], help.context);
  const helpText = help.stdout.join('');
  assert.equal(helpCode, 0);
  assert.match(helpText, /^Usage:\s+metabot agents <status\|hooks>/m);
  assert.match(helpText, /hooks install/);
  assert.equal(helpText.includes('Usage: metabot <command>'), false);
});

test('grouptask detail --help names --task and --chair, and --id is rejected', async () => {
  const help = capture();
  const helpCode = await runCli(['grouptask', 'detail', '--help'], help.context);
  const helpText = help.stdout.join('');
  assert.equal(helpCode, 0);
  assert.match(helpText, /--chair <bot-slug>/);
  assert.match(helpText, /--task <id>/);
  assert.equal(helpText.includes('Usage: metabot grouptask <subcommand>'), false);

  let called = false;
  const result = await runGroupTaskCommand(['detail', '--id', '328', '--json'], {
    stdout: { write: () => true },
    stderr: { write: () => true },
    dependencies: {
      grouptask: {
        detail: async () => {
          called = true;
          return commandSuccess({ task: 328 });
        },
      },
    },
  });
  assert.equal(called, false);
  assert.equal(result.code, 'invalid_flag');
  assert.match(result.message, /Unknown flag --id/);
  assert.match(result.message, /--task/);
});

test('chainhistory --help describes read record as a ledger write', async () => {
  const help = capture();
  const helpCode = await runCli(['chainhistory', '--help'], help.context);
  const helpText = help.stdout.join('');
  assert.equal(helpCode, 0);
  assert.match(helpText, /read record/);
  assert.match(helpText, /chainhistory recall/);
  assert.equal(/^\s+read\s+Read-side ledger entries\./m.test(helpText), false);
});

test('service-call poll timeout tells the user the order was broadcast and how to keep waiting', async () => {
  const stderr = [];
  const result = await pollTraceUntilComplete({
    traceId: 'trace-weather-1',
    localUiUrl: 'http://127.0.0.1:10001/ui/trace',
    timeoutMs: 0,
    intervalMs: 1,
    stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
    requestFn: async () => commandSuccess({
      session: { publicStatus: 'requesting_remote' },
    }),
  });
  assert.equal(result.completed, false);
  const text = stderr.join('');
  assert.match(text, /order was broadcast/);
  assert.match(text, /metabot trace get --trace-id trace-weather-1/);
});
