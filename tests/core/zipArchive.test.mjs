import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { mkdtempTempRootSync } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const { writeMetaAppZipArchive } = require('../../dist/core/metaapp/zipArchive.js');

async function makeSourceDir(root, name) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: determinism-probe\nversion: 1.0.0\n---\nbody\n', 'utf8');
  await fs.writeFile(path.join(dir, 'scripts', 'run.js'), 'export {}\n', 'utf8');
  return dir;
}

test('writeMetaAppZipArchive is byte-deterministic regardless of source file mtimes', async () => {
  const root = mkdtempTempRootSync();
  const dir = await makeSourceDir(root, 'skill');

  const first = await writeMetaAppZipArchive({ sourceDir: dir, outFile: path.join(root, 'first.zip') });
  // Disturb every source mtime: a deterministic archive must not absorb it,
  // because the on-chain skill pin binds the archive sha256 as content identity.
  const disturbedAt = new Date(Date.now() - 86_400_000);
  const entries = ['SKILL.md', path.join('scripts', 'run.js')];
  for (const entry of entries) {
    await fs.utimes(path.join(dir, entry), disturbedAt, disturbedAt);
  }
  const second = await writeMetaAppZipArchive({ sourceDir: dir, outFile: path.join(root, 'second.zip') });

  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(
    await fs.readFile(path.join(root, 'second.zip')),
    await fs.readFile(path.join(root, 'first.zip')),
  );
});
