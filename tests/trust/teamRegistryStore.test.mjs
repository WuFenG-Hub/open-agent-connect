import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  createTeamRegistryStore,
  listTeamRegistryGmids,
} = require('../../dist/core/trust/teamRegistryStore.js');
const { resolveMetabotOwnerPaths } = require('../../dist/core/state/paths.js');

const BOT_A = 'idq1teambotaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOT_B = 'idq1teambotbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('absent or corrupt registry reads as empty (P4b tolerates absence)', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-registry-');
  assert.deepEqual(await createTeamRegistryStore(systemHomeDir).list(), []);
  assert.deepEqual(await listTeamRegistryGmids(systemHomeDir), []);

  const registryPath = resolveMetabotOwnerPaths(systemHomeDir).teamRegistryPath;
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, '{corrupt', 'utf8');
  assert.deepEqual(await createTeamRegistryStore(systemHomeDir).list(), []);
});

test('entries normalize: gmids lowercased/deduped, junk dropped', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-registry-');
  const registryPath = resolveMetabotOwnerPaths(systemHomeDir).teamRegistryPath;
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify({
    version: 1,
    teamBots: [
      { globalMetaId: BOT_A.toUpperCase(), note: 'codex box', addedAt: '2026-10-16T00:00:00.000Z' },
      { globalMetaId: BOT_A, note: 'dup' },
      { globalMetaId: BOT_B },
      { globalMetaId: 'bogus' },
      { note: 'no gmid' },
      42,
    ],
  }, null, 2)}\n`, 'utf8');

  const entries = await createTeamRegistryStore(systemHomeDir).list();
  assert.deepEqual(entries, [
    { globalMetaId: BOT_A, source: 'manual', note: 'codex box', addedAt: '2026-10-16T00:00:00.000Z' },
    { globalMetaId: BOT_B, source: 'manual' },
  ]);
  assert.deepEqual(await listTeamRegistryGmids(systemHomeDir), [BOT_A, BOT_B]);
});

test('upsert adds, replaces by gmid, preserves addedAt, and persists atomically (0600)', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-registry-');
  const store = createTeamRegistryStore(systemHomeDir);

  await store.upsert({ globalMetaId: BOT_A, source: 'auto', addedAt: '2026-10-16T00:00:00.000Z' });
  await store.upsert({ globalMetaId: BOT_B.toUpperCase(), source: 'manual', note: 'work laptop' });
  let entries = await store.list();
  assert.deepEqual(entries, [
    { globalMetaId: BOT_A, source: 'auto', addedAt: '2026-10-16T00:00:00.000Z' },
    { globalMetaId: BOT_B, source: 'manual', note: 'work laptop' },
  ]);

  // Replace: manual add over an auto-recorded entry keeps the original addedAt.
  await store.upsert({ globalMetaId: BOT_A, source: 'manual', note: 'verified by hand' });
  entries = await store.list();
  assert.equal(entries.length, 2, 'upsert replaces, never duplicates');
  assert.deepEqual(entries[0], {
    globalMetaId: BOT_A,
    source: 'manual',
    addedAt: '2026-10-16T00:00:00.000Z',
    note: 'verified by hand',
  });

  const registryPath = resolveMetabotOwnerPaths(systemHomeDir).teamRegistryPath;
  const stat = await fs.stat(registryPath);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }

  await assert.rejects(
    () => store.upsert({ globalMetaId: 'bogus', source: 'manual' }),
    /Invalid GlobalMetaID/,
  );
});

test('remove drops one entry and is a no-op when absent', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-registry-');
  const store = createTeamRegistryStore(systemHomeDir);
  await store.upsert({ globalMetaId: BOT_A, source: 'manual' });
  await store.upsert({ globalMetaId: BOT_B, source: 'auto' });

  let entries = await store.remove(BOT_A.toUpperCase());
  assert.deepEqual(entries.map((entry) => entry.globalMetaId), [BOT_B]);
  entries = await store.remove(BOT_A);
  assert.deepEqual(entries.map((entry) => entry.globalMetaId), [BOT_B], 'removing an absent gmid is a no-op');
  await assert.rejects(() => store.remove('bogus'), /Invalid GlobalMetaID/);
});

test('auto-record: a team-tier resolution upserts an auto entry, once', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-registry-');
  const { createPeerTrustResolver } = require('../../dist/core/trust/peerTrustResolver.js');
  const { createOwnerIdentity } = require('../../dist/core/owner/ownerIdentity.js');

  const MY_OWNER = 'idq1myrootowner00000000000000000000000';
  const teamPeer = 'idq1teampeer00000000000000000000000000';
  const deviceRecord = await createOwnerIdentity(systemHomeDir, { name: 'Device' });

  const resolver = createPeerTrustResolver({
    systemHomeDir,
    rootOwnerResolver: {
      resolveRootOwner: async (gmid) => ({
        rootOwnerGlobalMetaId: gmid === deviceRecord.globalMetaId || gmid === teamPeer
          ? MY_OWNER
          : gmid,
        chain: [],
        fromCache: false,
      }),
      resolveDeviceOwner: async (gmid) => ({
        deviceOwnerGlobalMetaId: gmid,
        chain: [],
        fromCache: false,
      }),
      invalidate: async () => {},
    },
    trustedOwnerResolver: {
      resolveTrustedOwners: async () => ({ trustedOwners: [], fromCache: false }),
      invalidate: async () => {},
    },
    contactEvidence: async () => false,
    listLocalProfileGmids: async () => [],
  });

  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: teamPeer }), 'team');
  let entries = await createTeamRegistryStore(systemHomeDir).list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].globalMetaId, teamPeer);
  assert.equal(entries[0].source, 'auto');
  assert.ok(entries[0].addedAt, 'auto entries carry an addedAt');

  // Cached resolution must not duplicate.
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: teamPeer }), 'team');
  entries = await createTeamRegistryStore(systemHomeDir).list();
  assert.equal(entries.length, 1);
});
