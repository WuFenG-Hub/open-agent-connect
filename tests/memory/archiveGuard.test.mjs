// The `notUsedSince` guard on memory retirement, tested at the millisecond it
// actually breaks on. The integration test that covered this before drove the
// guard through a whole hygiene run, so it only tripped when a touch happened to
// land in the same millisecond as the snapshot — which is why it read as flaky
// for as long as it did. This test makes that instant explicit.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');
const { createMemoryStore } = require('../../dist/core/memory/memoryStore.js');

async function freshPaths() {
  const root = await mkdtempTempRoot('metabot-memguard-');
  const home = path.join(root, '.metabot', 'profiles', 'guard');
  await fs.mkdir(home, { recursive: true });
  return resolveMetabotPaths(home);
}

/** Create one retirable entry and return it with its exact lastUsedAt stamp. */
async function seedTouched(store, text) {
  const created = await store.create({
    text, usageClass: 'value_boundary', origin: 'dream', isExplicit: true, forceNew: true,
  });
  await store.list({ query: text, touchLastUsed: true });
  const row = (await store.list({ query: text })).find((entry) => entry.id === created.id);
  assert.ok(Number.isFinite(row.lastUsedAt), 'the touch must stamp a numeric lastUsedAt');
  return { id: created.id, stamp: row.lastUsedAt };
}

test('a memory touched at the very snapshot instant survives retirement', async () => {
  const store = createMemoryStore(await freshPaths());
  const { id, stamp } = await seedTouched(store, '价值边界:同毫秒竞态');

  // The hygiene snapshot lands on the SAME millisecond as the touch. At
  // millisecond granularity "at the snapshot" and "after the snapshot" cannot be
  // told apart, and the guard's documented intent is that anything touched since
  // the inventory snapshot must survive — so the row must be kept.
  const archived = await store.archiveMemories({
    ids: [id], archivedAt: new Date(stamp).toISOString(), notUsedSince: stamp,
  });
  assert.equal(archived, 0, 'a row touched at the snapshot instant must not be retired');
  const after = (await store.list({ includeArchived: true })).find((entry) => entry.id === id);
  assert.equal(after.archivedAt, null);
});

test('the guard still retires a row that was NOT touched after the snapshot', async () => {
  const store = createMemoryStore(await freshPaths());
  const { id, stamp } = await seedTouched(store, '价值边界:未被触碰');

  // One millisecond later than the touch: nothing has happened since the
  // snapshot, so the retirement proposal stands. This pins that the fix does not
  // simply disable the guard.
  const archived = await store.archiveMemories({
    ids: [id], archivedAt: new Date(stamp + 1).toISOString(), notUsedSince: stamp + 1,
  });
  assert.equal(archived, 1, 'a row untouched since the snapshot must still be retired');
  const after = (await store.list({ includeArchived: true })).find((entry) => entry.id === id);
  assert.notEqual(after.archivedAt, null);
});
