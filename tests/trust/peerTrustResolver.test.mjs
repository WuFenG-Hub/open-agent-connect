import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { createPeerTrustResolver } = require('../../dist/core/trust/peerTrustResolver.js');
const { createOwnerIdentity } = require('../../dist/core/owner/ownerIdentity.js');
const { blockGmid } = require('../../dist/core/trust/trustLocalStore.js');

const PEER = 'idq1peertrusttier0000000000000000000000';
const OTHER_PEER = 'idq1othertrustpeer00000000000000000000';
const MY_OWNER = 'idq1myrootowner00000000000000000000000';
const PEER_OWNER = 'idq1peerrootowner000000000000000000000';

/**
 * Test harness: a real temp home (device identity + trust-local.json on
 * disk), stubbed chain resolvers (root-owner walks + grant folds) and
 * stubbed local/evidence lookups, so each precedence rule is isolated.
 */
async function makeResolver(options = {}) {
  const systemHomeDir = await mkdtempTempRoot('metabot-peer-tier-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const state = {
    rootOwners: new Map([[device.globalMetaId, device.globalMetaId]]), // default: unbound device is its own root
    grants: new Map(),
    localGmids: [],
    evidencePeers: new Set(),
    rootCalls: 0,
    grantCalls: 0,
    evidenceCalls: 0,
  };
  const resolver = createPeerTrustResolver({
    systemHomeDir,
    rootOwnerResolver: {
      resolveRootOwner: async (gmid) => {
        state.rootCalls += 1;
        return { rootOwnerGlobalMetaId: state.rootOwners.get(gmid) ?? gmid, chain: [], fromCache: false };
      },
      resolveDeviceOwner: async (gmid) => ({
        deviceOwnerGlobalMetaId: state.rootOwners.get(gmid) ?? gmid,
        chain: [],
        fromCache: false,
      }),
      invalidate: async () => {},
    },
    trustedOwnerResolver: {
      resolveTrustedOwners: async (owner) => {
        state.grantCalls += 1;
        return { trustedOwners: state.grants.get(owner) ?? [], fromCache: false };
      },
      invalidate: async () => {},
    },
    contactEvidence: async (_profileHomeDir, peer) => {
      state.evidenceCalls += 1;
      return state.evidencePeers.has(peer);
    },
    listLocalProfileGmids: async () => state.localGmids,
    tierCacheTtlMs: options.tierCacheTtlMs ?? 60_000,
    now: options.now,
  });
  return { systemHomeDir, device, state, resolver };
}

test('blocked wins over every other tier, even local and team', async () => {
  const { systemHomeDir, device, state, resolver } = await makeResolver();
  state.localGmids = [PEER];
  state.rootOwners.set(PEER, device.globalMetaId); // would be team
  state.grants.set(device.globalMetaId, [{ trustedOwner: device.globalMetaId, ts: 1, grantPinId: 'g' }]);
  await blockGmid(systemHomeDir, PEER);

  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'blocked');
});

test('local: a peer that is one of this device\'s profiles', async () => {
  const { state, resolver } = await makeResolver();
  state.localGmids = [PEER];
  state.rootOwners.set(PEER, MY_OWNER);
  state.grants.set(MY_OWNER, [{ trustedOwner: MY_OWNER, ts: 1, grantPinId: 'g' }]);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'local');
});

test('team: peer root owner == my root owner (bound device)', async () => {
  const { device, state, resolver } = await makeResolver();
  state.rootOwners.set(device.globalMetaId, MY_OWNER);
  state.rootOwners.set(PEER, MY_OWNER);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'team');
});

test('team: unbound device still forms its one-device team', async () => {
  const { device, state, resolver } = await makeResolver();
  // Device identity is its own root owner (unbound); a peer whose chain
  // tops out at THIS device is team.
  state.rootOwners.set(PEER, device.globalMetaId);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'team');
});

test('trusted: peer root owner is in my owner\'s on-chain grants', async () => {
  const { device, state, resolver } = await makeResolver();
  state.rootOwners.set(device.globalMetaId, MY_OWNER);
  state.rootOwners.set(PEER, PEER_OWNER);
  state.grants.set(MY_OWNER, [{ trustedOwner: PEER_OWNER, note: 'audit', ts: 1730000000, grantPinId: 'g1' }]);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'trusted');
});

test('contact: two-way evidence qualifies when a profile home is given', async () => {
  const { state, resolver } = await makeResolver();
  state.evidencePeers.add(PEER);
  assert.equal(
    await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER, profileHomeDir: '/tmp/profile' }),
    'contact',
  );
  assert.equal(state.evidenceCalls, 1);
  assert.equal(
    await resolver.resolvePeerTrustTier({ peerGlobalMetaId: OTHER_PEER, profileHomeDir: '/tmp/profile' }),
    'stranger',
  );
});

test('contact: explicit contacts[] entry is honored without a profile home', async () => {
  const { systemHomeDir, resolver } = await makeResolver();
  const { markContact } = require('../../dist/core/trust/contactEvidence.js');
  await markContact(systemHomeDir, PEER);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'contact');
});

test('stranger: no binding, no grants, no evidence', async () => {
  const { resolver } = await makeResolver();
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: OTHER_PEER }), 'stranger');
});

test('tiers are cached; invalidate forces a recompute', async () => {
  const { device, state, resolver } = await makeResolver();
  state.rootOwners.set(device.globalMetaId, MY_OWNER);
  state.rootOwners.set(PEER, PEER_OWNER);
  state.grants.set(MY_OWNER, [{ trustedOwner: PEER_OWNER, ts: 1, grantPinId: 'g1' }]);

  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'trusted');
  const callsAfterFirst = state.rootCalls + state.grantCalls;
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'trusted');
  assert.equal(state.rootCalls + state.grantCalls, callsAfterFirst, 'second resolve is served from the tier cache');

  resolver.invalidate(PEER);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'trusted');
  assert.ok(state.rootCalls + state.grantCalls > callsAfterFirst, 'invalidate forces a recompute');
});

test('a block takes effect immediately, bypassing a warm cache', async () => {
  const { device, state, systemHomeDir, resolver } = await makeResolver();
  state.rootOwners.set(device.globalMetaId, MY_OWNER);
  state.rootOwners.set(PEER, MY_OWNER);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'team');

  await blockGmid(systemHomeDir, PEER);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'blocked', 'never cached');
});

test('a fresh contact mark promotes inside the TTL window', async () => {
  const { systemHomeDir, resolver } = await makeResolver();
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'stranger');
  const { markContact } = require('../../dist/core/trust/contactEvidence.js');
  await markContact(systemHomeDir, PEER);
  assert.equal(await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER }), 'contact');
});

test('the tier cache expires with its TTL', async () => {
  let now = 1_000_000;
  const { device, state, resolver } = await makeResolver({ now: () => now, tierCacheTtlMs: 60_000 });
  state.rootOwners.set(device.globalMetaId, MY_OWNER);
  state.rootOwners.set(PEER, MY_OWNER);

  await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER });
  const calls = state.rootCalls;
  now += 30_000;
  await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER });
  assert.equal(state.rootCalls, calls);
  now += 60_001;
  await resolver.resolvePeerTrustTier({ peerGlobalMetaId: PEER });
  assert.ok(state.rootCalls > calls, 'expired entry re-resolves');
});

test('invalid peer gmids are rejected', async () => {
  const { resolver } = await makeResolver();
  await assert.rejects(
    () => resolver.resolvePeerTrustTier({ peerGlobalMetaId: 'bogus' }),
    /Invalid GlobalMetaID/,
  );
});
