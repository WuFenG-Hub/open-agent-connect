import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  blockGmid,
  createTrustLocalStore,
  isBlockedGmid,
  normalizeTrustLocalState,
  unblockGmid,
} = require('../../dist/core/trust/trustLocalStore.js');
const { createTrustCacheStore } = require('../../dist/core/trust/trustCacheStore.js');
const { resolveMetabotOwnerPaths } = require('../../dist/core/state/paths.js');

const PEER_A = 'idq1peeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PEER_B = 'idq1peerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('missing file reads as an empty store', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-local-');
  const store = createTrustLocalStore(systemHomeDir);
  assert.deepEqual(await store.read(), { blocked: [], contacts: [] });
  assert.equal(await isBlockedGmid(systemHomeDir, PEER_A), false);
});

test('blocked/contact CRUD dedupes, normalizes case, and persists', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-local-');
  const store = createTrustLocalStore(systemHomeDir);

  await store.setBlocked(PEER_A.toUpperCase(), true);
  await store.setBlocked(PEER_A, true);
  await store.setBlocked(PEER_B, true);
  await store.setBlocked(PEER_B, false);
  let state = await store.read();
  assert.deepEqual(state.blocked, [PEER_A]);

  await store.setContact(PEER_B, true);
  await store.setContact(PEER_B, true);
  state = await store.read();
  assert.deepEqual(state.contacts, [PEER_B]);

  await store.setContact(PEER_B, false);
  state = await store.read();
  assert.deepEqual(state.contacts, []);

  const raw = JSON.parse(await fs.readFile(resolveMetabotOwnerPaths(systemHomeDir).trustLocalPath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.blocked, [PEER_A]);
});

test('defensive reads: corrupt file and junk fields normalize to empty', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-local-');
  const trustLocalPath = resolveMetabotOwnerPaths(systemHomeDir).trustLocalPath;
  await fs.mkdir(path.dirname(trustLocalPath), { recursive: true });
  await fs.writeFile(trustLocalPath, '{not json', 'utf8');
  assert.deepEqual(await createTrustLocalStore(systemHomeDir).read(), { blocked: [], contacts: [] });

  assert.deepEqual(
    normalizeTrustLocalState({ blocked: ['ok-gmid', 42, null, PEER_A, PEER_A], contacts: 'nope' }),
    { blocked: [PEER_A], contacts: [] },
  );
});

test('blockGmid/unblockGmid drop the peer\'s cached trust resolution', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-local-');
  const cache = createTrustCacheStore(systemHomeDir);
  await cache.set({
    subjectGlobalMetaId: PEER_A,
    pinId: 'pinbot1',
    rootOwnerGlobalMetaId: PEER_A,
    chain: [],
    resolvedAt: new Date().toISOString(),
  });
  assert.ok(await cache.get(PEER_A));

  await blockGmid(systemHomeDir, PEER_A);
  assert.equal(await cache.get(PEER_A), null, 'blocking drops the cached binding resolution');
  assert.equal(await isBlockedGmid(systemHomeDir, PEER_A), true);

  // Re-cache, then unblock — the entry is dropped again.
  await cache.set({
    subjectGlobalMetaId: PEER_A,
    pinId: 'pinbot2',
    rootOwnerGlobalMetaId: PEER_A,
    chain: [],
    resolvedAt: new Date().toISOString(),
  });
  await unblockGmid(systemHomeDir, PEER_A);
  assert.equal(await cache.get(PEER_A), null, 'unblocking also drops the cached entry');
  assert.equal(await isBlockedGmid(systemHomeDir, PEER_A), false);
});

test('invalid gmids are rejected and never written', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-local-');
  await assert.rejects(() => blockGmid(systemHomeDir, 'bogus'), /Invalid GlobalMetaID/);
  await assert.rejects(() => createTrustLocalStore(systemHomeDir).setContact('', true), /Invalid GlobalMetaID/);
  assert.deepEqual(await createTrustLocalStore(systemHomeDir).read(), { blocked: [], contacts: [] });
});
