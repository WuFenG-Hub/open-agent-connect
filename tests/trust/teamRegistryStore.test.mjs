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
    { globalMetaId: BOT_A, note: 'codex box', addedAt: '2026-10-16T00:00:00.000Z' },
    { globalMetaId: BOT_B },
  ]);
  assert.deepEqual(await listTeamRegistryGmids(systemHomeDir), [BOT_A, BOT_B]);
});
