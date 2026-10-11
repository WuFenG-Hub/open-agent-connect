import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { createSurfDaemonHandlers } = require('../../dist/daemon/surfHandlers.js');
const { createMetawebSurfStore } = require('../../dist/core/surf/store.js');
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');

test('recoverAfterRestart sweeps stale running runs for every profile home', async () => {
  const base = await mkdtempTempRoot('surf-zombie-sweep-');
  const homes = [];
  for (const slug of ['nori', 'sunnybot']) {
    const homeDir = path.join(base, '.metabot', 'profiles', slug);
    await fs.mkdir(homeDir, { recursive: true });
    const store = createMetawebSurfStore(resolveMetabotPaths(homeDir));
    await store.createRun({ id: `run-${slug}`, trigger: 'manual-ui', nowIso: new Date().toISOString() });
    homes.push(homeDir);
  }

  const group = createSurfDaemonHandlers({
    resolveBot: async () => ({ failure: { ok: false } }),
    listProfileHomeDirs: async () => homes,
  });
  const recovered = await group.recoverAfterRestart();
  assert.equal(recovered, 2);

  for (const [index, homeDir] of homes.entries()) {
    const store = createMetawebSurfStore(resolveMetabotPaths(homeDir));
    const runs = await store.listRuns(5);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].failure.code, 'STALE_RUNNING_SWEPT');
    assert.equal(await store.hasRunningRun(), false, `home ${index} should have no running run`);
  }
});
