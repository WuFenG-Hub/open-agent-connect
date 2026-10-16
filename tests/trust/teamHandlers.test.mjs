import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { createTeamDaemonHandlers } = require('../../dist/daemon/teamHandlers.js');
const { createOwnerIdentity } = require('../../dist/core/owner/ownerIdentity.js');
const { createTeamRegistryStore } = require('../../dist/core/trust/teamRegistryStore.js');

const MY_OWNER = 'idq1myrootowner00000000000000000000000';
const OTHER_OWNER = 'idq1otherrootowner0000000000000000000';
const PEER_SAME = 'idq1peersameowner0000000000000000000000';
const PEER_OTHER = 'idq1peerotherowner00000000000000000000';

function resultOf(promise) {
  return promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
}

function makeResolver(roots) {
  return {
    resolveRootOwner: async (gmid) => ({
      rootOwnerGlobalMetaId: roots[gmid] ?? gmid,
      chain: [],
      fromCache: false,
    }),
    resolveDeviceOwner: async (gmid) => ({
      deviceOwnerGlobalMetaId: roots[gmid] ?? gmid,
      chain: [],
      fromCache: false,
    }),
    invalidate: async () => {},
  };
}

async function makeHandlers(systemHomeDir, roots) {
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  roots[device.globalMetaId] = MY_OWNER; // my root owner
  return {
    device,
    handlers: createTeamDaemonHandlers({
      systemHomeDir,
      rootOwnerResolver: makeResolver(roots),
    }),
  };
}

test('team add: same root owner records a manual entry', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-add-');
  const { handlers } = await makeHandlers(systemHomeDir, { [PEER_SAME]: MY_OWNER });

  const result = await handlers.add({ globalMetaId: PEER_SAME });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.entry.globalMetaId, PEER_SAME);
  assert.equal(result.data.entry.source, 'manual');
  assert.ok(result.data.entry.addedAt);

  const entries = await createTeamRegistryStore(systemHomeDir).list();
  assert.equal(entries.length, 1);
});

test('team add: a different root owner fails with team_not_same_owner', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-add-');
  const { handlers } = await makeHandlers(systemHomeDir, { [PEER_OTHER]: OTHER_OWNER });

  const result = await resultOf(handlers.add({ globalMetaId: PEER_OTHER }));
  assert.equal(result.ok, true, 'the command envelope succeeds');
  assert.equal(result.value.ok, false);
  assert.equal(result.value.code, 'team_not_same_owner');
  assert.match(result.value.message, /not bound to your root owner/);
  assert.deepEqual(await createTeamRegistryStore(systemHomeDir).list(), [], 'nothing is recorded');
});

test('team add: unresolvable peer root owner fails closed without recording', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-add-');
  // Resolver that throws for the peer.
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const handlers = createTeamDaemonHandlers({
    systemHomeDir,
    rootOwnerResolver: {
      resolveRootOwner: async (gmid) => {
        if (gmid === device.globalMetaId) return { rootOwnerGlobalMetaId: MY_OWNER, chain: [], fromCache: false };
        throw new Error('indexer unreachable');
      },
      resolveDeviceOwner: async (gmid) => ({ deviceOwnerGlobalMetaId: gmid, chain: [], fromCache: false }),
      invalidate: async () => {},
    },
  });

  const result = await handlers.add({ globalMetaId: PEER_SAME });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'team_root_owner_unresolved');
  assert.deepEqual(await createTeamRegistryStore(systemHomeDir).list(), []);
});

test('team add: invalid gmid and missing verification wiring fail clearly', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-add-');
  const { handlers } = await makeHandlers(systemHomeDir, {});

  const invalid = await handlers.add({ globalMetaId: 'bogus' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_global_meta_id');

  const unwired = createTeamDaemonHandlers({ systemHomeDir });
  const result = await unwired.add({ globalMetaId: PEER_SAME });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'team_verification_unavailable');
});

test('team remove: drops the entry; list combines local profiles and the registry', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-team-add-');
  const { handlers } = await makeHandlers(systemHomeDir, { [PEER_SAME]: MY_OWNER });
  await handlers.add({ globalMetaId: PEER_SAME });

  const removed = await handlers.remove({ globalMetaId: PEER_SAME });
  assert.equal(removed.ok, true);
  assert.equal(removed.data.removed, PEER_SAME);
  assert.deepEqual(removed.data.registry, []);

  const listed = await handlers.list({});
  assert.equal(listed.ok, true);
  assert.equal(listed.data.profiles.length, 0, 'no local Bot profiles on a bare home');
  assert.deepEqual(listed.data.registry, []);
});
