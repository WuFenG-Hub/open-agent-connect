import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { mkdtempTempRootSync } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  normalizeClaudeHookPayload,
} = require('../../dist/core/agents/claudeHookEvents.js');
const {
  createAgentStatusStore,
} = require('../../dist/core/agents/agentStatusStore.js');
const {
  renderEndpointFile,
  writeAgentHookEndpointFile,
  readAgentHookEndpointFile,
  drainAgentHookSpool,
} = require('../../dist/core/agents/agentHookEndpoint.js');
const {
  renderClaudeHookScript,
  isManagedClaudeHookCommand,
} = require('../../dist/core/agents/claudeHookScript.js');
const {
  installClaudeHooks,
  uninstallClaudeHooks,
  planClaudeHookInstall,
} = require('../../dist/core/agents/claudeHookInstaller.js');

const NOW = 1_700_000_000_000;

function claudePayload(overrides = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'build it',
    ...overrides,
  };
}

test('normalizeClaudeHookPayload maps hook events onto the four-state vocabulary', () => {
  const working = normalizeClaudeHookPayload(claudePayload(), () => NOW);
  assert.equal(working.state, 'working');
  assert.equal(working.prompt, 'build it');

  assert.equal(normalizeClaudeHookPayload(claudePayload({ hook_event_name: 'PermissionRequest' }), () => NOW).state, 'waiting');
  assert.equal(normalizeClaudeHookPayload(claudePayload({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), () => NOW).state, 'waiting');
  assert.equal(normalizeClaudeHookPayload(claudePayload({ hook_event_name: 'Stop' }), () => NOW).state, 'done');

  const boundary = normalizeClaudeHookPayload(claudePayload({ hook_event_name: 'SessionStart', source: 'startup' }), () => NOW);
  assert.equal(boundary.state, 'done');
  assert.equal(boundary.sessionBoundary, true);

  // Fail closed on unknown SessionStart sources and unrecognized events.
  assert.equal(normalizeClaudeHookPayload(claudePayload({ hook_event_name: 'SessionStart', source: 'weird' }), () => NOW), null);
  assert.equal(normalizeClaudeHookPayload(claudePayload({ hook_event_name: 'WhateverNewThing' }), () => NOW), null);
  assert.equal(normalizeClaudeHookPayload({ hook_event_name: 'Stop' }), null);
});

test('agent status store tracks per-session state, history fields, and reaps stale rows', () => {
  const store = createAgentStatusStore(() => NOW);
  const seen = [];
  store.subscribe((event, record) => seen.push([event.hookEventName, record.state]));
  store.ingest(normalizeClaudeHookPayload(claudePayload(), () => NOW));
  store.ingest(normalizeClaudeHookPayload(claudePayload({ hook_event_name: 'PermissionRequest' }), () => NOW + 1000));

  let rows = store.snapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'waiting');
  assert.equal(rows[0].firstObservedAt, NOW);
  assert.equal(rows[0].stateStartedAt, NOW + 1000);
  assert.equal(rows[0].lastHookEvent, 'PermissionRequest');
  assert.deepEqual(seen.map(([event]) => event), ['UserPromptSubmit', 'PermissionRequest']);

  // 30 minutes silent: dropped.
  rows = store.snapshot(() => NOW + 1000 + 31 * 60 * 1000);
  assert.equal(rows.length, 0);
});

test('endpoint file round-trips atomically and rejects unsafe values', async () => {
  const root = mkdtempTempRootSync();
  const agentsDir = path.join(root, 'agents');
  const good = renderEndpointFile({ port: 1234, token: 'abc-DEF.0', version: '1' });
  assert.match(good, /METABOT_AGENT_HOOK_PORT=1234/);
  assert.throws(() => renderEndpointFile({ port: 1234, token: 'a b;rm -rf', version: '1' }));
  assert.equal(readAgentHookEndpointFile(agentsDir) instanceof Promise, true);

  await writeAgentHookEndpointFile(agentsDir, { port: 4321, token: 'tok-1', version: '1' });
  const read = await readAgentHookEndpointFile(agentsDir);
  assert.deepEqual(read, { port: 4321, token: 'tok-1', version: '1' });
  const entries = await fs.readdir(agentsDir);
  assert.equal(entries.some((entry) => entry.startsWith('hook-endpoint.env.tmp-')), false);
});

test('spool drain ingests complete records, skips stale ones, and keeps torn tails', async () => {
  const root = mkdtempTempRootSync();
  const spool = path.join(root, 'spool');
  await fs.mkdir(spool, { recursive: true });
  const file = path.join(spool, 'claude-code.jsonl');
  const fresh = NOW - 1000;
  await fs.writeFile(file, [
    JSON.stringify({ source: 'claude-code', receivedAt: fresh, payload: { session_id: 's1', hook_event_name: 'Stop' } }),
    JSON.stringify({ source: 'claude-code', receivedAt: NOW - 8 * 24 * 60 * 60 * 1000, payload: { session_id: 's2', hook_event_name: 'Stop' } }),
  ].join('\n') + '\n' + '{"source":"claude-code","receivedAt":', 'utf8');

  const ingested = [];
  const count = await drainAgentHookSpool(spool, (record) => ingested.push(record), () => NOW);
  assert.equal(count, 1);
  assert.equal(ingested[0].payload.session_id, 's1');
  const remaining = await fs.readFile(file, 'utf8');
  assert.equal(remaining, '{"source":"claude-code","receivedAt":');
});

test('claude hook script renders the neutral-stdout contract and endpoint discovery', () => {
  const root = mkdtempTempRootSync();
  const agentsDir = path.join(root, 'agents');
  const script = renderClaudeHookScript(agentsDir);
  assert.match(script, /^#!\/bin\/sh/);
  // Neutral JSON first: permission hooks fail closed on empty stdout.
  assert.ok(script.indexOf("printf '{}\\n'") < script.indexOf('payload=$(cat'));
  assert.match(script, /hook-endpoint\.env/);
  assert.match(script, /api\/agents\/hooks\/claude-code/);
  assert.match(script, /X-Metabot-Agent-Hook-Token/);
  assert.match(script, /spool\/claude-code\.jsonl/);
  assert.equal(isManagedClaudeHookCommand(script), false);
  assert.equal(isManagedClaudeHookCommand(`if [ -f '${agentsDir}/metabot-claude-hook.sh' ]; then :; fi`), true);
});

test('installer owns only its entries, preserves user hooks, and uninstalls cleanly', async () => {
  const root = mkdtempTempRootSync();
  const home = path.join(root, 'home');
  const agentsDir = path.join(root, 'metabot', 'agents');
  const settingsPath = path.join(home, '.claude', 'settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done', timeout: 5 }] }],
    },
  }, null, 2), 'utf8');

  const plan = await planClaudeHookInstall({ agentsDir, homeDir: home });
  assert.equal(plan.alreadyInstalled, false);
  assert.deepEqual(plan.existingUserHookEvents, ['Stop']);

  const installed = await installClaudeHooks({ agentsDir, homeDir: home });
  assert.equal(installed.changed, true);
  const doc = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.equal(doc.model, 'opus');
  // User hook preserved verbatim inside Stop, alongside the managed entry.
  const stopCommands = doc.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.ok(stopCommands.includes('say done'));
  assert.ok(stopCommands.some((command) => command.includes('metabot-claude-hook.sh')));
  assert.ok(doc.hooks.PreToolUse.some((group) => group.matcher === '*'));
  await assert.doesNotReject(fs.access(path.join(agentsDir, 'metabot-claude-hook.sh')));

  // Idempotent: a second install changes nothing.
  const again = await installClaudeHooks({ agentsDir, homeDir: home });
  assert.equal(again.changed, false);

  const uninstalled = await uninstallClaudeHooks({ agentsDir, homeDir: home });
  assert.equal(uninstalled.changed, true);
  const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(after.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command)), ['say done']);
  assert.equal(after.hooks.PreToolUse, undefined);
  await assert.doesNotReject(fs.access(path.join(agentsDir, 'metabot-claude-hook.sh')).then(() => {
    throw new Error('script should be removed');
  }, () => undefined));
});
