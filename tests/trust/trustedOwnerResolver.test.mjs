import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  computeEffectiveTrustGrants,
  createTrustedOwnerResolver,
} = require('../../dist/core/trust/trustedOwnerResolver.js');
const { resolveMetabotOwnerPaths } = require('../../dist/core/state/paths.js');

const OWNER_A = 'idq1owneraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_B = 'idq1ownerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWNER_C = 'idq1ownerccccccccccccccccccccccccccccccc';

function grantPin(pinId, trustedOwner, ts, note) {
  const payload = { version: 1, trustedOwner, ts };
  if (note) payload.note = note;
  return { pinId, operation: 'create', timestamp: ts, payload: JSON.stringify(payload) };
}

function revokePin(pinId, revoke, ts) {
  return { pinId, operation: 'create', timestamp: ts, payload: JSON.stringify({ version: 1, revoke, ts }) };
}

test('computeEffectiveTrustGrants: single grant resolves to one entry', () => {
  const grants = computeEffectiveTrustGrants([grantPin('g1', OWNER_A, 100, 'first')]);
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0], { trustedOwner: OWNER_A, note: 'first', ts: 100, grantPinId: 'g1' });
});

test('computeEffectiveTrustGrants: grant then revoke cancels it', () => {
  const grants = computeEffectiveTrustGrants([
    grantPin('g1', OWNER_A, 100),
    revokePin('r1', 'g1', 200),
  ]);
  assert.equal(grants.length, 0);
});

test('computeEffectiveTrustGrants: revoke without a matching grant is a no-op', () => {
  const grants = computeEffectiveTrustGrants([
    grantPin('g1', OWNER_A, 100),
    revokePin('r1', 'unknownPin', 200),
  ]);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].grantPinId, 'g1');
});

test('computeEffectiveTrustGrants: duplicate grants collapse to the newest', () => {
  const grants = computeEffectiveTrustGrants([
    grantPin('g1', OWNER_A, 100, 'old note'),
    grantPin('g2', OWNER_A, 300, 'new note'),
    grantPin('g3', OWNER_B, 200),
  ]);
  assert.equal(grants.length, 2);
  const a = grants.find((g) => g.trustedOwner === OWNER_A);
  assert.equal(a.grantPinId, 'g2');
  assert.equal(a.note, 'new note');
  assert.equal(a.ts, 300);
  assert.deepEqual(grants.map((g) => g.trustedOwner).sort(), [OWNER_A, OWNER_B].sort());
});

test('computeEffectiveTrustGrants: revoked grant does not resurrect; newer re-grant stands', () => {
  const grants = computeEffectiveTrustGrants([
    grantPin('g1', OWNER_A, 100),
    revokePin('r1', 'g1', 150),
    grantPin('g2', OWNER_A, 200, 're-granted'),
  ]);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].grantPinId, 'g2');
});

test('computeEffectiveTrustGrants: malformed payloads are skipped', () => {
  const grants = computeEffectiveTrustGrants([
    { pinId: 'bad1', operation: 'create', timestamp: 100, payload: 'not json' },
    { pinId: 'bad2', operation: 'create', timestamp: 101, payload: null },
    { pinId: 'bad3', operation: 'create', timestamp: 102, payload: JSON.stringify({ version: 2, trustedOwner: OWNER_A, ts: 1 }) },
    grantPin('g1', OWNER_A, 103),
  ]);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].grantPinId, 'g1');
});

function mockPinLister(pins) {
  let calls = 0;
  const seen = [];
  const lister = async (gmid, path) => {
    calls += 1;
    seen.push([gmid, path]);
    return pins;
  };
  return { lister, stats: { get calls() { return calls; }, seen } };
}

test('resolveTrustedOwners folds the lister result and caches by owner gmid', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-resolve-');
  const pins = [
    grantPin('g1', OWNER_A, 100, 'first'),
    grantPin('g2', OWNER_B, 200),
    revokePin('r1', 'g1', 300),
  ];
  const { lister, stats } = mockPinLister(pins);
  const resolver = createTrustedOwnerResolver({ systemHomeDir, pinLister: lister });

  const first = await resolver.resolveTrustedOwners('idq1theowner0000000000000000000000000');
  assert.equal(first.fromCache, false);
  assert.equal(first.trustedOwners.length, 1);
  assert.equal(first.trustedOwners[0].trustedOwner, OWNER_B);
  assert.equal(stats.calls, 1);
  assert.equal(stats.seen[0][1], '/protocols/simpletrust');

  const second = await resolver.resolveTrustedOwners('idq1theowner0000000000000000000000000');
  assert.equal(second.fromCache, true);
  assert.equal(second.trustedOwners.length, 1);
  assert.equal(stats.calls, 1, 'cache hit performs zero chain reads');

  await resolver.invalidate('idq1theowner0000000000000000000000000');
  const third = await resolver.resolveTrustedOwners('idq1theowner0000000000000000000000000');
  assert.equal(third.fromCache, false);
  assert.equal(stats.calls, 2);
});

test('grant cache persists to trust-cache.json and survives a new resolver instance', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-resolve-');
  const pins = [grantPin('g1', OWNER_A, 100, 'persisted')];
  const { lister, stats } = mockPinLister(pins);
  const resolver = createTrustedOwnerResolver({ systemHomeDir, pinLister: lister });
  const ownerGmid = 'idq1persistowner0000000000000000000000';
  await resolver.resolveTrustedOwners(ownerGmid);
  assert.equal(stats.calls, 1);

  const cachePath = resolveMetabotOwnerPaths(systemHomeDir).trustCachePath;
  const raw = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(raw.grants[ownerGmid].pinId, 'g1');
  assert.equal(raw.grants[ownerGmid].trustedOwners[0].note, 'persisted');

  // A fresh resolver over the same home serves the cache; a throwing lister
  // proves it is never consulted.
  const resolver2 = createTrustedOwnerResolver({
    systemHomeDir,
    pinLister: async () => { throw new Error('chain must not be read'); },
  });
  const cached = await resolver2.resolveTrustedOwners(ownerGmid);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.trustedOwners[0].trustedOwner, OWNER_A);
});

test('an expired TTL re-folds from the chain', async () => {
  const systemHomeDir = await mkdtempTempRoot('metabot-trust-resolve-');
  const { lister, stats } = mockPinLister([grantPin('g1', OWNER_C, 100)]);
  let now = 1_000_000;
  const resolver = createTrustedOwnerResolver({
    systemHomeDir,
    pinLister: lister,
    now: () => now,
    cacheTtlMs: 60_000,
  });
  const ownerGmid = 'idq1ttlowner00000000000000000000000000';

  await resolver.resolveTrustedOwners(ownerGmid);
  assert.equal(stats.calls, 1);
  now += 30_000;
  await resolver.resolveTrustedOwners(ownerGmid);
  assert.equal(stats.calls, 1);
  now += 60_001;
  await resolver.resolveTrustedOwners(ownerGmid);
  assert.equal(stats.calls, 2, 'expired grant entry re-resolves');
});

test('resolveTrustedOwners rejects malformed owner gmids; read failure resolves empty', async () => {
  const resolver = createTrustedOwnerResolver({ pinLister: mockPinLister([]).lister });
  await assert.rejects(() => resolver.resolveTrustedOwners('bogus'), /Invalid GlobalMetaID/);

  const failing = createTrustedOwnerResolver({
    pinLister: async () => { throw new Error('indexer unreachable'); },
  });
  const resolution = await failing.resolveTrustedOwners(OWNER_C);
  assert.deepEqual(resolution.trustedOwners, []);
  assert.equal(resolution.fromCache, false);
});
