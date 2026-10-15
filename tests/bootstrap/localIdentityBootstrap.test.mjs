import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createProfileHome } from '../helpers/profileHome.mjs';
import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  createLocalMetabotStep,
  createMetabotSubsidyStep,
  createLocalIdentitySyncStep,
} = require('../../dist/core/bootstrap/localIdentityBootstrap.js');
const { ensureProfileWorkspace } = require('../../dist/core/identity/profileWorkspace.js');
const { createRuntimeStateStore } = require('../../dist/core/state/runtimeStateStore.js');
const { createFileSecretStore } = require('../../dist/core/secrets/fileSecretStore.js');

const FIXTURE_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('createLocalMetabotStep persists the first local identity with pending bootstrap state', async () => {
  const homeDir = await createProfileHome('metabot-bootstrap-local-');
  const runtimeStateStore = createRuntimeStateStore(homeDir);
  const secretStore = createFileSecretStore(homeDir);

  const createMetabot = createLocalMetabotStep({
    runtimeStateStore,
    secretStore,
    now: () => 1_744_444_444_000,
    generateMnemonic: () => FIXTURE_MNEMONIC,
  });

  const created = await createMetabot({ name: 'Alice' });
  const state = await runtimeStateStore.readState();
  const secrets = await secretStore.readIdentitySecrets();

  assert.equal(created.metabot.name, 'Alice');
  assert.equal(created.metabot.subsidyState, 'pending');
  assert.equal(created.metabot.syncState, 'pending');
  assert.equal(created.subsidyInput.mvcAddress, created.metabot.mvcAddress);
  assert.equal(created.subsidyInput.mnemonic, FIXTURE_MNEMONIC);
  assert.equal(state.identity.name, 'Alice');
  assert.equal(state.identity.subsidyState, 'pending');
  assert.equal(state.identity.syncState, 'pending');
  assert.equal(secrets.mnemonic, FIXTURE_MNEMONIC);
  assert.equal(secrets.globalMetaId, created.metabot.globalMetaId);
});

test('createMetabotSubsidyStep persists claimed subsidy state after a successful reward flow', async () => {
  const homeDir = await createProfileHome('metabot-bootstrap-subsidy-');
  const runtimeStateStore = createRuntimeStateStore(homeDir);
  const secretStore = createFileSecretStore(homeDir);

  const createMetabot = createLocalMetabotStep({
    runtimeStateStore,
    secretStore,
    now: () => 1_744_444_444_000,
    generateMnemonic: () => FIXTURE_MNEMONIC,
  });
  const created = await createMetabot({ name: 'Alice' });

  const requestSubsidy = createMetabotSubsidyStep({
    runtimeStateStore,
    requestMvcGasSubsidy: async (input) => ({
      success: true,
      step1: { address: input.mvcAddress },
      step2: { address: input.mvcAddress, rewarded: true },
    }),
  });

  const result = await requestSubsidy({
    request: { name: 'Alice' },
    metabot: created.metabot,
    subsidyInput: created.subsidyInput,
  });

  const state = await runtimeStateStore.readState();
  assert.equal(result.success, true);
  assert.equal(state.identity.subsidyState, 'claimed');
  assert.equal(state.identity.subsidyError, null);
});

test('createLocalIdentitySyncStep persists name first and auto-retries chatpubkey with canSkip=false on final failure', async () => {
  const homeDir = await createProfileHome('metabot-bootstrap-sync-');
  const runtimeStateStore = createRuntimeStateStore(homeDir);
  const secretStore = createFileSecretStore(homeDir);

  const createMetabot = createLocalMetabotStep({
    runtimeStateStore,
    secretStore,
    now: () => 1_744_444_444_000,
    generateMnemonic: () => FIXTURE_MNEMONIC,
  });
  const created = await createMetabot({ name: 'Alice' });

  const calls = [];
  let chatAttempts = 0;
  const syncIdentityToChain = createLocalIdentitySyncStep({
    runtimeStateStore,
    signer: {
      writePin: async (input) => {
        calls.push(input.path);
        if (input.path === '/info/chatpubkey') {
          chatAttempts += 1;
          if (chatAttempts <= 2) {
            throw new Error('indexer still catching up');
          }
        }
        return {
          pinId: `${input.path}-pin-${calls.length}`,
          txids: [`${input.path}-tx-${calls.length}`],
          totalCost: 1,
          network: 'mvc',
          operation: 'create',
          path: input.path,
          contentType: input.contentType,
          encoding: input.encoding ?? 'utf-8',
          globalMetaId: created.metabot.globalMetaId,
          mvcAddress: created.metabot.mvcAddress,
        };
      },
    },
    wait: async () => {},
    stepDelayMs: 0,
    chatPubkeyMaxRetries: 2,
    chatPubkeyRetryDelayMs: 0,
  });

  const firstAttempt = await syncIdentityToChain({
    request: { name: 'Alice' },
    metabot: created.metabot,
    subsidy: { success: true },
  });
  const stateAfterFirstAttempt = await runtimeStateStore.readState();

  // Should auto-retry 2 times (total 3 attempts), succeed on 3rd
  assert.deepEqual(calls, ['/info/name', '/info/chatpubkey', '/info/chatpubkey', '/info/chatpubkey']);
  assert.equal(firstAttempt.success, true);
  assert.equal(stateAfterFirstAttempt.identity.namePinId, '/info/name-pin-1');
  assert.equal(stateAfterFirstAttempt.identity.chatPublicKeyPinId, '/info/chatpubkey-pin-4');
  assert.equal(stateAfterFirstAttempt.identity.syncState, 'synced');
  assert.equal(stateAfterFirstAttempt.identity.syncError, null);
});

test('createLocalIdentitySyncStep fails with canSkip=false when chatpubkey exhausts retries', async () => {
  const homeDir = await createProfileHome('metabot-bootstrap-sync-fail-');
  const runtimeStateStore = createRuntimeStateStore(homeDir);
  const secretStore = createFileSecretStore(homeDir);

  const createMetabot = createLocalMetabotStep({
    runtimeStateStore,
    secretStore,
    now: () => 1_744_444_444_000,
    generateMnemonic: () => FIXTURE_MNEMONIC,
  });
  const created = await createMetabot({ name: 'Alice' });

  const calls = [];
  const syncIdentityToChain = createLocalIdentitySyncStep({
    runtimeStateStore,
    signer: {
      writePin: async (input) => {
        calls.push(input.path);
        if (input.path === '/info/chatpubkey') {
          throw new Error('persistent chain failure');
        }
        return {
          pinId: `${input.path}-pin-${calls.length}`,
          txids: [`${input.path}-tx-${calls.length}`],
          totalCost: 1,
          network: 'mvc',
          operation: 'create',
          path: input.path,
          contentType: input.contentType,
          encoding: input.encoding ?? 'utf-8',
          globalMetaId: created.metabot.globalMetaId,
          mvcAddress: created.metabot.mvcAddress,
        };
      },
    },
    wait: async () => {},
    stepDelayMs: 0,
    chatPubkeyMaxRetries: 2,
    chatPubkeyRetryDelayMs: 0,
  });

  const result = await syncIdentityToChain({
    request: { name: 'Alice' },
    metabot: created.metabot,
    subsidy: { success: true },
  });
  const state = await runtimeStateStore.readState();

  // Should try 3 times (initial + 2 retries)
  assert.deepEqual(calls, ['/info/name', '/info/chatpubkey', '/info/chatpubkey', '/info/chatpubkey']);
  assert.equal(result.success, false);
  assert.equal(result.canSkip, false);
  assert.match(result.error, /Failed to sync chatPublicKey after 3 attempts/);
  assert.equal(state.identity.namePinId, '/info/name-pin-1');
  assert.equal(state.identity.chatPublicKeyPinId, null);
  assert.equal(state.identity.syncState, 'failed');
  assert.match(state.identity.syncError, /Failed to sync chatPublicKey after 3 attempts/);
});

test('ensureProfileWorkspace creates the required workspace files and eager runtime directories', async () => {
  const systemHome = await mkdtempTempRoot('metabot-profile-workspace-');
  const homeDir = path.join(systemHome, '.metabot', 'profiles', 'alice');

  await ensureProfileWorkspace({
    homeDir,
    name: 'Alice',
  });

  for (const relativePath of [
    'AGENTS.md',
    'SOUL.md',
    'IDENTITY.md',
    'USER.md',
    'MEMORY.md',
    'memory',
    '.runtime',
    '.runtime/sessions',
    '.runtime/exports',
    '.runtime/state',
    '.runtime/locks',
    '.runtime/config.json',
  ]) {
    const targetPath = path.join(homeDir, relativePath);
    const targetStat = await stat(targetPath);
    assert.equal(Boolean(targetStat), true, `${relativePath} should exist`);
  }

  await assert.rejects(
    stat(path.join(homeDir, '.runtime/evolution')),
    { code: 'ENOENT' }
  );

  const agentsMd = await readFile(path.join(homeDir, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /profile slug is `alice`/);
  assert.match(agentsMd, /--from alice/);
});
