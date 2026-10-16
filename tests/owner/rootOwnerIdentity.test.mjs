import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { mkdtempTempRoot } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  createRootOwnerIdentity,
  deleteRootOwnerIdentity,
  importRootOwnerIdentity,
  loadRootOwnerIdentity,
  renameRootOwnerIdentity,
  resolveRootOwnerIdentityPath,
  revealRootOwnerMnemonic,
  rootOwnerExists,
  toRootOwnerIdentityPublic,
  RootOwnerIdentityError,
} = require('../../dist/core/owner/rootOwnerIdentity.js');
const { resolveMetabotOwnerPaths } = require('../../dist/core/state/paths.js');

async function tempSystemHome() {
  return mkdtempTempRoot('metabot-root-owner-');
}

test('create writes a 0600 root owner identity and load returns it', async () => {
  const systemHomeDir = await tempSystemHome();
  const record = await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  assert.equal(record.name, 'Alice');
  assert.ok(record.mnemonic.split(/\s+/).length >= 12);
  assert.ok(record.globalMetaId.startsWith('id'));
  assert.ok(record.mvcAddress.length > 0);

  const readBack = await loadRootOwnerIdentity(systemHomeDir);
  assert.equal(readBack.globalMetaId, record.globalMetaId);
  assert.equal(await rootOwnerExists(systemHomeDir), true);

  const stat = await fs.stat(resolveRootOwnerIdentityPath(systemHomeDir));
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }

  const publicRecord = toRootOwnerIdentityPublic(record);
  assert.equal(publicRecord.mnemonic, undefined);
  assert.equal(publicRecord.globalMetaId, record.globalMetaId);

  // The file lives at the central owner path next to the device identity.
  const ownerPaths = resolveMetabotOwnerPaths(systemHomeDir);
  assert.equal(resolveRootOwnerIdentityPath(systemHomeDir), ownerPaths.rootOwnerIdentityPath);
});

test('create fails when a root owner identity already exists', async () => {
  const systemHomeDir = await tempSystemHome();
  await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  await assert.rejects(
    () => createRootOwnerIdentity(systemHomeDir, { name: 'Bob' }),
    (error) => error instanceof RootOwnerIdentityError && error.code === 'root_owner_exists',
  );
});

test('import rejects an invalid mnemonic', async () => {
  const systemHomeDir = await tempSystemHome();
  await assert.rejects(
    () => importRootOwnerIdentity(systemHomeDir, { name: 'Alice', mnemonic: 'not a mnemonic at all' }),
    (error) => error instanceof RootOwnerIdentityError && error.code === 'invalid_mnemonic',
  );
});

test('import round-trips a mnemonic to the same globalMetaId', async () => {
  const sourceHome = await tempSystemHome();
  const targetHome = await tempSystemHome();
  const source = await createRootOwnerIdentity(sourceHome, { name: 'Portable Alice' });
  const mnemonic = await revealRootOwnerMnemonic(sourceHome);
  assert.equal(mnemonic, source.mnemonic);

  const imported = await importRootOwnerIdentity(targetHome, { name: 'Alice', mnemonic });
  assert.equal(imported.globalMetaId, source.globalMetaId);
  assert.equal(imported.mvcAddress, source.mvcAddress);
  assert.equal(await rootOwnerExists(targetHome), true);

  await assert.rejects(
    () => importRootOwnerIdentity(targetHome, { name: 'Again', mnemonic }),
    (error) => error instanceof RootOwnerIdentityError && error.code === 'root_owner_exists',
  );
});

test('rename updates the name and rejects empty names', async () => {
  const systemHomeDir = await tempSystemHome();
  await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const renamed = await renameRootOwnerIdentity(systemHomeDir, '  Alice Cooper  ');
  assert.equal(renamed.name, 'Alice Cooper');
  assert.equal((await loadRootOwnerIdentity(systemHomeDir)).name, 'Alice Cooper');
  await assert.rejects(
    () => renameRootOwnerIdentity(systemHomeDir, '   '),
    (error) => error instanceof RootOwnerIdentityError && error.code === 'invalid_name',
  );
});

test('reveal and missing-identity errors follow the device identity contract', async () => {
  const systemHomeDir = await tempSystemHome();
  await assert.rejects(
    () => revealRootOwnerMnemonic(systemHomeDir),
    (error) => error instanceof RootOwnerIdentityError && error.code === 'root_owner_missing',
  );
  await assert.rejects(
    () => renameRootOwnerIdentity(systemHomeDir, 'Alice'),
    (error) => error instanceof RootOwnerIdentityError && error.code === 'root_owner_missing',
  );

  await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  const mnemonic = await revealRootOwnerMnemonic(systemHomeDir);
  assert.ok(mnemonic.split(/\s+/).length >= 12);
});

test('delete removes the file and is idempotent', async () => {
  const systemHomeDir = await tempSystemHome();
  await createRootOwnerIdentity(systemHomeDir, { name: 'Alice' });
  await deleteRootOwnerIdentity(systemHomeDir);
  assert.equal(await loadRootOwnerIdentity(systemHomeDir), null);
  assert.equal(await rootOwnerExists(systemHomeDir), false);
  await deleteRootOwnerIdentity(systemHomeDir); // no throw on ENOENT
});
