import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { mkdtempTempRootSync } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { runCli } = require('../../dist/cli/main.js');
const { createConfigStore } = require('../../dist/core/config/configStore.js');
const { createDefaultConfig } = require('../../dist/core/config/configTypes.js');
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');

function createProfileHome(prefix, slug = 'actor-alice') {
  const systemHome = mkdtempTempRootSync(prefix);
  const homeDir = path.join(systemHome, '.metabot', 'profiles', slug);
  const managerRoot = path.join(systemHome, '.metabot', 'manager');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(managerRoot, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(managerRoot, 'identity-profiles.json'),
    `${JSON.stringify({
      profiles: [{
        name: slug,
        slug,
        aliases: [slug],
        homeDir,
        globalMetaId: '',
        mvcAddress: '',
        createdAt: now,
        updatedAt: now,
      }],
    }, null, 2)}\n`,
    'utf8',
  );
  const botRoleStatePath = resolveMetabotPaths(homeDir).botRoleStatePath;
  mkdirSync(path.dirname(botRoleStatePath), { recursive: true });
  writeFileSync(
    botRoleStatePath,
    `${JSON.stringify({ botType: 'twin', ownerGlobalMetaId: null, updatedAt: new Date(now).toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return homeDir;
}

async function runConfigCli(homeDir, args) {
  const stdout = [];
  const exitCode = await runCli(args, {
    env: { ...process.env, HOME: path.dirname(path.dirname(path.dirname(homeDir))), METABOT_HOME: homeDir },
    cwd: homeDir,
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
  });
  return { exitCode, payload: JSON.parse(stdout.join('').trim()) };
}

test('createDefaultConfig carries an empty trust section', () => {
  const config = createDefaultConfig();
  assert.deepEqual(config.trust, { skillClassOverrides: {}, chatTrustPolicy: {} });
});

test('configStore normalizes the trust section defensively', async () => {
  const homeDir = createProfileHome('metabot-trust-config-');
  const store = createConfigStore(homeDir);

  // Pre-P3 files have no trust section; defaults fill in.
  let config = await store.read();
  assert.deepEqual(config.trust, { skillClassOverrides: {}, chatTrustPolicy: {} });

  // Junk fields are dropped, valid overrides survive, and a full
  // write-then-read roundtrip keeps them.
  config.trust.skillClassOverrides = {
    'metabot-memory': 'C1',
    'metabot-help': 'C9',     // invalid class — dropped
    'bogus-entry': 42,        // invalid value — dropped
  };
  config.trust.chatTrustPolicy = {
    chat: { stranger: 'queue', bogus: 'auto' },
    invite: { blocked: 'decline' },
  };
  await store.set(config);
  const readBack = await store.read();
  assert.deepEqual(readBack.trust.skillClassOverrides, { 'metabot-memory': 'C1' });
  assert.deepEqual(readBack.trust.chatTrustPolicy, {
    chat: { stranger: 'queue' },
    invite: { blocked: 'decline' },
  });
});

test('metabot config get/set round-trips the trust.* keys as JSON', async () => {
  const homeDir = createProfileHome('metabot-trust-config-');

  const setResult = await runConfigCli(homeDir, [
    'config', 'set', 'trust.skillClassOverrides', '{"metabot-memory":"C1"}',
  ]);
  assert.equal(setResult.exitCode, 0, JSON.stringify(setResult.payload));
  assert.deepEqual(setResult.payload.data, { key: 'trust.skillClassOverrides', value: { 'metabot-memory': 'C1' } });

  const getResult = await runConfigCli(homeDir, ['config', 'get', 'trust.skillClassOverrides']);
  assert.equal(getResult.exitCode, 0);
  assert.deepEqual(getResult.payload.data.value, { 'metabot-memory': 'C1' });

  const policySet = await runConfigCli(homeDir, [
    'config', 'set', 'trust.chatTrustPolicy', '{"chat":{"stranger":"queue"}}',
  ]);
  assert.equal(policySet.exitCode, 0, JSON.stringify(policySet.payload));
  assert.deepEqual(policySet.payload.data.value, { chat: { stranger: 'queue' } });
});

test('metabot config set rejects malformed JSON for trust.* keys', async () => {
  const homeDir = createProfileHome('metabot-trust-config-');
  const result = await runConfigCli(homeDir, [
    'config', 'set', 'trust.skillClassOverrides', '{not json',
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.code, 'invalid_argument');
});
