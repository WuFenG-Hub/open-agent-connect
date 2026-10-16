import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { createOwnerIdentity } = require('../../dist/core/owner/ownerIdentity.js');
const { createRootOwnerIdentity } = require('../../dist/core/owner/rootOwnerIdentity.js');
const { signOwnerBinding } = require('../../dist/core/owner/ownerBinding.js');
const { createRootOwnerResolver } = require('../../dist/core/trust/rootOwnerResolver.js');
const { resolveMetabotOwnerPaths } = require('../../dist/core/state/paths.js');

// The subject (Bot) gmid never leaves the signed statement, so any
// well-formed GlobalMetaID string works for it; the owners in the payloads
// must be real derived identities because verifyOwnerBinding decodes them.
const BOT_GMID = 'idq1testbot0000000000000000000000000000';

async function makeBoundWorld() {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-resolve-');
  const device = await createOwnerIdentity(systemHomeDir, { name: 'Device' });
  const rootOwner = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const botToDevice = (await signOwnerBinding(device, BOT_GMID)).payload;
  const deviceToOwner = (await signOwnerBinding(rootOwner, device.globalMetaId)).payload;
  return { systemHomeDir, device, rootOwner, botToDevice, deviceToOwner };
}

function mockPinReader(pins) {
  let reads = 0;
  const readSubjects = [];
  const reader = async (gmid) => {
    reads += 1;
    readSubjects.push(gmid);
    const pin = pins.get(gmid);
    return pin ? { pinId: pin.pinId, payload: pin.payload } : null;
  };
  return { reader, stats: { get reads() { return reads; }, readSubjects } };
}

test('resolveRootOwner with no pin terminates at the subject (0 hops, legacy-safe)', async () => {
  const { reader, stats } = mockPinReader(new Map());
  const resolver = createRootOwnerResolver({ pinReader: reader });

  const resolution = await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(resolution.rootOwnerGlobalMetaId, BOT_GMID);
  assert.deepEqual(resolution.chain, []);
  assert.equal(resolution.fromCache, false);
  assert.equal(stats.reads, 1);

  // A device that never published a binding resolves to itself.
  const { device } = await makeBoundWorld();
  const pins = new Map([[device.globalMetaId, { pinId: 'pindev1', payload: '' }]]);
  const resolver2 = createRootOwnerResolver({ pinReader: mockPinReader(pins).reader });
  assert.equal((await resolver2.resolveRootOwner(device.globalMetaId)).rootOwnerGlobalMetaId, device.globalMetaId);
});

test('resolveRootOwner walks one hop Bot→Device and stops at the unbound device', async () => {
  const { device, botToDevice } = await makeBoundWorld();
  const { reader, stats } = mockPinReader(new Map([
    [BOT_GMID, { pinId: 'pinbot1', payload: botToDevice }],
  ]));
  const resolver = createRootOwnerResolver({ pinReader: reader });

  const resolution = await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(resolution.rootOwnerGlobalMetaId, device.globalMetaId);
  assert.equal(resolution.chain.length, 1);
  assert.deepEqual(resolution.chain[0], {
    subjectGmid: BOT_GMID,
    ownerGmid: device.globalMetaId,
    pinId: 'pinbot1',
  });
  // Both the bot pin and the (absent) device pin are read: the walk only
  // knows the device is unbound after reading its latest pin.
  assert.equal(stats.reads, 2);
});

test('resolveRootOwner walks two hops Bot→Device→Owner', async () => {
  const { device, rootOwner, botToDevice, deviceToOwner } = await makeBoundWorld();
  const { reader, stats } = mockPinReader(new Map([
    [BOT_GMID, { pinId: 'pinbot1', payload: botToDevice }],
    [device.globalMetaId, { pinId: 'pindev1', payload: deviceToOwner }],
  ]));
  const resolver = createRootOwnerResolver({ pinReader: reader });

  const resolution = await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(resolution.rootOwnerGlobalMetaId, rootOwner.globalMetaId);
  assert.equal(resolution.chain.length, 2);
  assert.equal(resolution.chain[0].ownerGmid, device.globalMetaId);
  assert.equal(resolution.chain[1].subjectGmid, device.globalMetaId);
  assert.equal(resolution.chain[1].ownerGmid, rootOwner.globalMetaId);
  assert.equal(stats.reads, 2);
});

test('an invalid signature terminates the walk at the last verified link', async () => {
  const { device, botToDevice, deviceToOwner } = await makeBoundWorld();
  const tampered = JSON.parse(deviceToOwner);
  tampered.signature = Buffer.from('a'.repeat(65)).toString('base64');

  const { reader, stats } = mockPinReader(new Map([
    [BOT_GMID, { pinId: 'pinbot1', payload: botToDevice }],
    [device.globalMetaId, { pinId: 'pindev1', payload: JSON.stringify(tampered) }],
  ]));
  const resolver = createRootOwnerResolver({ pinReader: reader });

  const resolution = await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(resolution.rootOwnerGlobalMetaId, device.globalMetaId);
  assert.equal(resolution.chain.length, 1);
  assert.equal(stats.reads, 2);
});

test('resolveDeviceOwner returns exactly one hop (the device)', async () => {
  const { device, rootOwner, botToDevice, deviceToOwner } = await makeBoundWorld();
  const { reader, stats } = mockPinReader(new Map([
    [BOT_GMID, { pinId: 'pinbot1', payload: botToDevice }],
    [device.globalMetaId, { pinId: 'pindev1', payload: deviceToOwner }],
  ]));
  const resolver = createRootOwnerResolver({ pinReader: reader });

  const resolution = await resolver.resolveDeviceOwner(BOT_GMID);
  assert.equal(resolution.deviceOwnerGlobalMetaId, device.globalMetaId);
  assert.equal(resolution.chain.length, 1);
  assert.equal(stats.reads, 1);
});

test('cache hit inside the TTL avoids any chain re-read', async () => {
  const { device, rootOwner, botToDevice, deviceToOwner, systemHomeDir } = await makeBoundWorld();
  const { reader, stats } = mockPinReader(new Map([
    [BOT_GMID, { pinId: 'pinbot1', payload: botToDevice }],
    [device.globalMetaId, { pinId: 'pindev1', payload: deviceToOwner }],
  ]));
  const resolver = createRootOwnerResolver({ systemHomeDir, pinReader: reader });

  const first = await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(first.fromCache, false);
  assert.equal(stats.reads, 2);

  const second = await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(second.fromCache, true);
  assert.equal(second.rootOwnerGlobalMetaId, rootOwner.globalMetaId);
  assert.equal(second.chain.length, 2);
  assert.equal(stats.reads, 2, 'no additional pin reads on a cache hit');

  // The cached 2-hop chain also serves a 1-hop device resolve, truncated.
  const deviceView = await resolver.resolveDeviceOwner(BOT_GMID);
  assert.equal(deviceView.fromCache, true);
  assert.equal(deviceView.deviceOwnerGlobalMetaId, device.globalMetaId);
  assert.equal(deviceView.chain.length, 1);
  assert.equal(stats.reads, 2);

  // forceRefresh bypasses the cache.
  const refreshed = await resolver.resolveRootOwner(BOT_GMID, { forceRefresh: true });
  assert.equal(refreshed.fromCache, false);
  assert.equal(stats.reads, 4);
});

test('cache entries persist to trust-cache.json and survive a new resolver instance', async () => {
  const { device, botToDevice, systemHomeDir } = await makeBoundWorld();
  const pins = new Map([[BOT_GMID, { pinId: 'pinbot1', payload: botToDevice }]]);
  const firstReader = mockPinReader(pins);
  const resolver = createRootOwnerResolver({ systemHomeDir, pinReader: firstReader.reader });
  await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(firstReader.stats.reads, 2);

  const cachePath = resolveMetabotOwnerPaths(systemHomeDir).trustCachePath;
  const raw = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries[BOT_GMID].pinId, 'pinbot1');
  assert.equal(raw.entries[BOT_GMID].rootOwnerGlobalMetaId, device.globalMetaId);

  // A fresh resolver over the same home must serve the entry without reading
  // the chain; a reader that throws proves it is never consulted.
  const resolver2 = createRootOwnerResolver({
    systemHomeDir,
    pinReader: async () => { throw new Error('chain must not be read'); },
  });
  const cached = await resolver2.resolveRootOwner(BOT_GMID);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.rootOwnerGlobalMetaId, device.globalMetaId);

  // Invalidating one subject drops exactly its entry.
  await resolver2.invalidate(BOT_GMID);
  const resolver3 = createRootOwnerResolver({ systemHomeDir, pinReader: mockPinReader(pins).reader });
  const again = await resolver3.resolveRootOwner(BOT_GMID);
  assert.equal(again.fromCache, false);
});

test('an expired TTL re-resolves from the chain', async () => {
  const { botToDevice, systemHomeDir } = await makeBoundWorld();
  const pins = new Map([[BOT_GMID, { pinId: 'pinbot1', payload: botToDevice }]]);
  const { reader, stats } = mockPinReader(pins);

  let now = 1_000_000;
  const resolver = createRootOwnerResolver({
    systemHomeDir,
    pinReader: reader,
    now: () => now,
    cacheTtlMs: 60_000,
  });

  await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(stats.reads, 2);

  now += 30_000;
  await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(stats.reads, 2, 'still fresh inside the TTL');

  now += 60_001;
  await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(stats.reads, 4, 'expired entry re-resolves');
});

test('resolveRootOwner rejects malformed GlobalMetaIDs', async () => {
  const { reader } = mockPinReader(new Map());
  const resolver = createRootOwnerResolver({ pinReader: reader });
  await assert.rejects(() => resolver.resolveRootOwner('not-a-gmid'), /Invalid GlobalMetaID/);
  await assert.rejects(() => resolver.resolveDeviceOwner(''), /Invalid GlobalMetaID/);
});

test('a pin read failure terminates the walk conservatively instead of throwing', async () => {
  const { device, botToDevice } = await makeBoundWorld();
  let calls = 0;
  const pinReader = async (gmid) => {
    calls += 1;
    if (gmid === device.globalMetaId) throw new Error('indexer unreachable');
    return { pinId: 'pinbot1', payload: botToDevice };
  };
  const resolver = createRootOwnerResolver({ pinReader });

  const resolution = await resolver.resolveRootOwner(BOT_GMID);
  assert.equal(resolution.rootOwnerGlobalMetaId, device.globalMetaId);
  assert.equal(resolution.chain.length, 1);
  assert.equal(calls, 2);
});
