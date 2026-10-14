import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { mkdtempTempRootSync } from '../helpers/tempRoots.mjs';

const require = createRequire(import.meta.url);
const {
  parseSkillFrontmatter,
  readBlockScalarValue,
  normalizeSkillName,
  extractSkillPinDescriptor,
  downloadSkillArchive,
  installSkillArchive,
  installSkillFromReference,
  listInstalledSkills,
  readInstalledSkill,
  uninstallInstalledSkill,
  readInstalledSkillsRegistry,
  writeInstalledSkillsRegistry,
  sweepSkillInstallLeftovers,
  MAX_SKILL_PACKAGE_BYTES,
  SkillInstallError,
} = require('../../dist/core/skills/skillInstall.js');
const { writeMetaAppZipArchive } = require('../../dist/core/metaapp/zipArchive.js');
const { bindPlatformSkills } = require('../../dist/core/host/hostSkillBinding.js');

const ZIP_PIN_ID = 'a'.repeat(64) + 'i0';
const SKILL_PIN_ID = 'b'.repeat(64) + 'i0';

function skillDoc(name, version = '1.0.0', body = 'Follow the steps.') {
  return `---\nname: ${name}\nversion: ${version}\ndescription: "A test skill"\n---\n\n# ${name}\n\n${body}\n`;
}

async function makeSkillZip(dir, entries) {
  for (const [relativePath, content] of Object.entries(entries)) {
    const target = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  const outFile = path.join(dir, '..', `${path.basename(dir)}.zip`);
  await writeMetaAppZipArchive({ sourceDir: dir, outFile });
  return fs.readFile(outFile);
}

function zipResponse(buffer) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

test('parseSkillFrontmatter reads flat scalar fields', () => {
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: metabot-example\nversion: 2.1.0\ndescription: "Does things"\n---\n\n# body\n'),
    { name: 'metabot-example', version: '2.1.0', description: 'Does things' },
  );
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter\n'), {});
  assert.deepEqual(parseSkillFrontmatter('---\nname: x\n'), {});
});

test('parseSkillFrontmatter unfolds literal and folded block scalars', () => {
  // Literal `|` keeps the line breaks.
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: metabot-block\nversion: 1.0.0\ndescription: |\n  First line of the real description.\n  Second line.\n---\n\n# body\n'),
    { name: 'metabot-block', version: '1.0.0', description: 'First line of the real description.\nSecond line.' },
  );
  // Folded `>` joins the body lines with spaces.
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: metabot-folded\ndescription: >\n  First line.\n  Second line.\n---\n'),
    { name: 'metabot-folded', description: 'First line. Second line.' },
  );
  // Extra indentation inside the block survives the indentation strip.
  assert.equal(
    parseSkillFrontmatter('---\ndescription: |\n  Intro line.\n\n    Indented code line.\n---\n').description,
    'Intro line.\n\n  Indented code line.',
  );
  // Every chomping indicator unfolds to the body text.
  for (const indicator of ['|', '|-', '|+', '>', '>-', '>+']) {
    assert.equal(
      parseSkillFrontmatter(`---\nname: metabot-chomp\ndescription: ${indicator}\n  Kept body.\n---\n`).description,
      'Kept body.',
      `${indicator} should unfold the block scalar to its body text`,
    );
  }
});

test('readBlockScalarValue applies the `-`/`+` chomping indicators to trailing blank lines', () => {
  // Two blank lines trail the body, plus the break before the closing `---`.
  const lines = ['description: |+', '  body', '', ''];
  assert.equal(readBlockScalarValue(lines, 1, 0, '|', '').value, 'body\n');
  assert.equal(readBlockScalarValue(lines, 1, 0, '|', '-').value, 'body');
  assert.equal(readBlockScalarValue(lines, 1, 0, '|', '+').value, 'body\n\n');

  // Folded style joins the same body, and the body ends at the first line
  // that is not indented deeper than the key.
  const folded = ['description: >', '  one', '  two', 'version: 1.0.0'];
  assert.deepEqual(readBlockScalarValue(folded, 1, 0, '>', ''), { value: 'one two\n', lastLineIndex: 2 });
});

test('parseSkillFrontmatter treats a block indicator without a body as absent', () => {
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: metabot-empty\ndescription: |\n---\n'),
    { name: 'metabot-empty' },
  );
  // A shallower key ends the body, so the indicator still has no body.
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: metabot-empty\ndescription: |-\nversion: 1.0.0\n---\n'),
    { name: 'metabot-empty', version: '1.0.0' },
  );
});

test('normalizeSkillName accepts directory-safe names only', () => {
  assert.equal(normalizeSkillName('metabot-example'), 'metabot-example');
  assert.equal(normalizeSkillName('My_Skill.2'), 'My_Skill.2');
  assert.equal(normalizeSkillName(''), '');
  assert.equal(normalizeSkillName('.hidden'), '');
  assert.equal(normalizeSkillName('..'), '');
  assert.equal(normalizeSkillName('a/b'), '');
  assert.equal(normalizeSkillName('a\\b'), '');
  assert.equal(normalizeSkillName('x'.repeat(65)), '');
});

test('extractSkillPinDescriptor accepts known payload spellings', () => {
  assert.deepEqual(
    extractSkillPinDescriptor({
      payload: { name: 'metabot-example', 'skill-file': `metafile://${ZIP_PIN_ID}.zip`, version: '1.2', description: 'd' },
      creator: { globalMetaId: 'IDQ1', name: 'Fisher' },
    }),
    { name: 'metabot-example', description: 'd', version: '1.2', skillFileUri: `metafile://${ZIP_PIN_ID}.zip`, sha256: '' },
  );
  assert.deepEqual(
    extractSkillPinDescriptor({
      payload: { name: 'metabot-example', 'skill-file': `metafile://${ZIP_PIN_ID}.zip`, sha256: 'AB'.repeat(32) },
    }),
    { name: 'metabot-example', description: '', version: '0', skillFileUri: `metafile://${ZIP_PIN_ID}.zip`, sha256: 'ab'.repeat(32) },
  );
  assert.ok(extractSkillPinDescriptor({ payload: { skillName: 'x', skillFileUri: `metafile://${ZIP_PIN_ID}` } }));
  assert.equal(extractSkillPinDescriptor({ payload: { name: 'x' } }), null);
  assert.equal(extractSkillPinDescriptor({ payload: null }), null);
});

test('downloadSkillArchive resolves metafile URIs through the content URLs', async () => {
  const calls = [];
  const archive = Buffer.from('pk-zip-bytes');
  const fetched = await downloadSkillArchive({
    contentReference: `metafile://${ZIP_PIN_ID}.zip`,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return calls.length === 1
        ? { status: 502, ok: false }
        : zipResponse(archive);
    },
  });
  assert.deepEqual(fetched, archive);
  assert.ok(calls[0].includes('/accelerate/content/'));
  assert.ok(calls[1].includes('/content/'));

  await assert.rejects(
    downloadSkillArchive({ contentReference: 'not-a-uri', fetchImpl: async () => zipResponse(archive) }),
    (error) => error instanceof SkillInstallError && error.code === 'invalid_source',
  );
  await assert.rejects(
    downloadSkillArchive({
      contentReference: `metafile://${ZIP_PIN_ID}`,
      fetchImpl: async () => ({ status: 500, ok: false }),
    }),
    (error) => error instanceof SkillInstallError && error.code === 'download_failed',
  );
});

test('downloadSkillArchive enforces the package size cap', async () => {
  const big = Buffer.alloc(MAX_SKILL_PACKAGE_BYTES + 1, 1);
  await assert.rejects(
    downloadSkillArchive({ contentReference: `metafile://${ZIP_PIN_ID}`, fetchImpl: async () => zipResponse(big) }),
    (error) => error instanceof SkillInstallError && error.code === 'invalid_package' && /exceeds/.test(error.message),
  );
  await assert.rejects(
    downloadSkillArchive({
      contentReference: `metafile://${ZIP_PIN_ID}`,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: { get: (name) => (name === 'content-length' ? String(MAX_SKILL_PACKAGE_BYTES + 10) : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }),
    (error) => error instanceof SkillInstallError && error.code === 'invalid_package',
  );
});

test('downloadSkillArchive verifies the advertised sha256 and refuses mismatches', async () => {
  const archive = Buffer.from('pk-zip-bytes');
  const advertised = createHash('sha256').update(archive).digest('hex');

  const fetched = await downloadSkillArchive({
    contentReference: `metafile://${ZIP_PIN_ID}`,
    fetchImpl: async () => zipResponse(archive),
    expectedSha256: advertised.toUpperCase(),
  });
  assert.deepEqual(fetched, archive);

  await assert.rejects(
    downloadSkillArchive({
      contentReference: `metafile://${ZIP_PIN_ID}`,
      fetchImpl: async () => zipResponse(Buffer.from('tampered-pk-zip-bytes')),
      expectedSha256: advertised,
    }),
    (error) => error instanceof SkillInstallError && error.code === 'digest_mismatch' && /digest mismatch/.test(error.message),
  );

  // No advertised digest (legacy pin): nothing to verify against, download proceeds.
  const legacy = await downloadSkillArchive({
    contentReference: `metafile://${ZIP_PIN_ID}`,
    fetchImpl: async () => zipResponse(archive),
  });
  assert.deepEqual(legacy, archive);
});

test('installSkillFromReference verifies the pin-advertised digest end to end', async () => {
  const root = mkdtempTempRootSync();
  const zip = await makeSkillZip(path.join(root, 'pkg'), {
    'SKILL.md': skillDoc('digest-roundtrip', '2.0.0'),
  });
  const advertised = createHash('sha256').update(zip).digest('hex');

  const installed = await installSkillFromReference({
    skillsRoot: path.join(root, 'skills'),
    contentReference: `metafile://${ZIP_PIN_ID}.zip`,
    fetchImpl: async () => zipResponse(zip),
    source: { payloadSha256: advertised },
  });
  assert.equal(installed.name, 'digest-roundtrip');
  assert.equal(installed.version, '2.0.0');

  await assert.rejects(
    installSkillFromReference({
      skillsRoot: path.join(root, 'skills2'),
      contentReference: `metafile://${ZIP_PIN_ID}.zip`,
      fetchImpl: async () => zipResponse(Buffer.concat([zip, Buffer.from('x')])),
      source: { payloadSha256: advertised },
    }),
    (error) => error instanceof SkillInstallError && error.code === 'digest_mismatch',
  );
});

test('installSkillArchive installs a root-SKILL.md package with provenance', async () => {
  const root = mkdtempTempRootSync('skill-install-');
  const skillsRoot = path.join(root, '.metabot', 'skills');
  const staging = path.join(root, 'pkg');
  const archive = await makeSkillZip(staging, {
    'SKILL.md': skillDoc('metabot-demo', '3.2.1'),
    'scripts/run.js': 'console.log("demo");\n',
  });

  const installed = await installSkillArchive({
    skillsRoot,
    archive,
    source: { creatorMetaId: 'IDQ1', creatorName: 'Fisher', sourcePinId: SKILL_PIN_ID, skillFileUri: `metafile://${ZIP_PIN_ID}.zip` },
    now: () => 1_787_000_000_000,
  });

  assert.equal(installed.name, 'metabot-demo');
  assert.equal(installed.version, '3.2.1');
  assert.equal(installed.replaced, false);
  assert.equal(installed.skillDir, path.join(skillsRoot, 'metabot-demo'));
  assert.deepEqual(installed.files, ['SKILL.md', 'scripts/run.js']);
  await assert.equal(
    await fs.readFile(path.join(skillsRoot, 'metabot-demo', 'SKILL.md'), 'utf8'),
    skillDoc('metabot-demo', '3.2.1'),
  );

  const registry = await readInstalledSkillsRegistry(skillsRoot);
  assert.equal(registry.skills['metabot-demo'].creatorMetaId, 'IDQ1');
  assert.equal(registry.skills['metabot-demo'].sourcePinId, SKILL_PIN_ID);
  assert.equal(registry.skills['metabot-demo'].enabled, true);
  // Staging leftovers never survive an install.
  assert.equal((await fs.readdir(skillsRoot)).filter((name) => name.startsWith('.skill-install-')).length, 0);
});

test('installSkillArchive stores the unfolded block-scalar description (D1 acceptance shape)', async () => {
  const root = mkdtempTempRootSync('skill-block-scalar-');
  const skillsRoot = path.join(root, '.metabot', 'skills');
  const archive = await makeSkillZip(path.join(root, 'pkg'), {
    'SKILL.md': '---\nname: humanizer\nversion: 3.0.0\ndescription: |\n  First line of the real description.\n  Second line.\n---\n\n# humanizer\n',
  });

  const installed = await installSkillArchive({
    skillsRoot,
    archive,
    source: { creatorMetaId: 'IDQ1', payloadDescription: 'Description from the pin payload.' },
  });

  assert.equal(installed.description, 'First line of the real description.\nSecond line.');
  const registry = await readInstalledSkillsRegistry(skillsRoot);
  assert.equal(registry.skills.humanizer.description, 'First line of the real description.\nSecond line.');
});

test('installSkillArchive falls back to the pin payload description when the frontmatter body is empty', async () => {
  const root = mkdtempTempRootSync('skill-block-scalar-fallback-');
  const skillsRoot = path.join(root, '.metabot', 'skills');
  const archive = await makeSkillZip(path.join(root, 'pkg'), {
    'SKILL.md': '---\nname: indicator-only\nversion: 1.0.0\ndescription: |\n---\n\n# indicator-only\n',
  });

  const installed = await installSkillArchive({
    skillsRoot,
    archive,
    source: { creatorMetaId: 'IDQ1', payloadDescription: 'Description from the pin payload.' },
  });

  assert.equal(installed.description, 'Description from the pin payload.');
});

test('installSkillArchive unwraps a single wrapping directory', async () => {
  const root = mkdtempTempRootSync('skill-unwrap-');
  const skillsRoot = path.join(root, '.metabot', 'skills');
  const archive = await makeSkillZip(path.join(root, 'pkg'), {
    'wrapped/SKILL.md': skillDoc('wrapped-skill'),
  });
  const installed = await installSkillArchive({ skillsRoot, archive });
  assert.equal(installed.name, 'wrapped-skill');
  await assert.ok(fs.stat(path.join(skillsRoot, 'wrapped-skill', 'SKILL.md')));
});

test('installSkillArchive rejects packages without SKILL.md', async () => {
  const root = mkdtempTempRootSync('skill-nodoc-');
  const archive = await makeSkillZip(path.join(root, 'pkg'), { 'README.md': '# no skill doc\n' });
  await assert.rejects(
    installSkillArchive({ skillsRoot: path.join(root, '.metabot', 'skills'), archive }),
    (error) => error instanceof SkillInstallError && error.code === 'invalid_package' && /SKILL.md/.test(error.message),
  );
});

test('installSkillArchive guards names against conflicts and supports publisher-stable upgrades', async () => {
  const root = mkdtempTempRootSync('skill-conflict-');
  const skillsRoot = path.join(root, '.metabot', 'skills');
  const archiveV1 = await makeSkillZip(path.join(root, 'pkg1'), { 'SKILL.md': skillDoc('metabot-demo', '1.0.0') });
  const archiveV2 = await makeSkillZip(path.join(root, 'pkg2'), { 'SKILL.md': skillDoc('metabot-demo', '2.0.0') });

  await installSkillArchive({ skillsRoot, archive: archiveV1, source: { creatorMetaId: 'IDQ1', sourcePinId: SKILL_PIN_ID } });

  // Different publisher claiming the same name is refused.
  await assert.rejects(
    installSkillArchive({ skillsRoot, archive: archiveV2, source: { creatorMetaId: 'IDQ2' } }),
    (error) => error instanceof SkillInstallError && error.code === 'name_conflict' && /different publisher/.test(error.message),
  );
  // Same publisher upgrades in place.
  const upgraded = await installSkillArchive({ skillsRoot, archive: archiveV2, source: { creatorMetaId: 'IDQ1' } });
  assert.equal(upgraded.replaced, true);
  assert.equal(upgraded.previousVersion, '1.0.0');
  assert.equal(upgraded.version, '2.0.0');
  // --force overrides the publisher check.
  const forced = await installSkillArchive({ skillsRoot, archive: archiveV2, source: { creatorMetaId: 'IDQ3' }, force: true });
  assert.equal(forced.version, '2.0.0');

  // A pre-existing local skill with no registry entry is never clobbered.
  await fs.mkdir(path.join(skillsRoot, 'local-skill'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'local-skill', 'SKILL.md'), skillDoc('local-skill'), 'utf8');
  const localArchive = await makeSkillZip(path.join(root, 'pkg3'), { 'SKILL.md': skillDoc('local-skill') });
  await assert.rejects(
    installSkillArchive({ skillsRoot, archive: localArchive }),
    (error) => error instanceof SkillInstallError && error.code === 'name_conflict' && /not installed from MetaWeb/.test(error.message),
  );
});

test('list, read, and uninstall round-trip one installed skill', async () => {
  const root = mkdtempTempRootSync('skill-roundtrip-');
  const skillsRoot = path.join(root, '.metabot', 'skills');
  const archive = await makeSkillZip(path.join(root, 'pkg'), {
    'SKILL.md': skillDoc('round-trip', '0.9.0', 'Steps here.'),
    'assets/data.txt': 'x',
  });
  await installSkillArchive({ skillsRoot, archive, source: { creatorMetaId: 'IDQ1' } });

  const listed = await listInstalledSkills(skillsRoot);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'round-trip');
  assert.equal(listed[0].present, true);

  const read = await readInstalledSkill({ skillsRoot, name: 'round-trip' });
  assert.match(read.skillMd, /# round-trip/);
  assert.deepEqual(read.files, ['SKILL.md', 'assets/data.txt']);

  const removed = await uninstallInstalledSkill({ skillsRoot, name: 'round-trip' });
  assert.equal(removed.removedDir, true);
  assert.deepEqual((await listInstalledSkills(skillsRoot)), []);
  await assert.rejects(
    uninstallInstalledSkill({ skillsRoot, name: 'round-trip' }),
    (error) => error instanceof SkillInstallError && error.code === 'name_conflict',
  );
});

test('read_skill says "not installed" with an install path for unknown skills, and "corrupt" for broken ones (N-3)', async () => {
  const root = mkdtempTempRootSync('skill-read-errors-');
  const skillsRoot = path.join(root, '.metabot', 'skills');

  await assert.rejects(
    readInstalledSkill({ skillsRoot, name: 'never-installed' }),
    (error) => {
      assert.ok(error instanceof SkillInstallError);
      assert.match(error.message, /Skill "never-installed" is not installed locally/);
      assert.match(error.message, /metabot skills install --pin <pinId> --confirm/);
      assert.doesNotMatch(error.message, /No SKILL\.md found/);
      return true;
    },
  );

  // A registry entry (or leftover directory) without SKILL.md = installed but corrupt.
  const archive = await makeSkillZip(path.join(root, 'pkg'), { 'SKILL.md': skillDoc('broken-one', '1.0.0') });
  await installSkillArchive({ skillsRoot, archive, source: { creatorMetaId: 'IDQ1' } });
  await fs.rm(path.join(skillsRoot, 'broken-one', 'SKILL.md'));
  await assert.rejects(
    readInstalledSkill({ skillsRoot, name: 'broken-one' }),
    (error) => {
      assert.ok(error instanceof SkillInstallError);
      assert.match(error.message, /is installed under .* but its SKILL\.md is missing — the package is corrupt/);
      assert.match(error.message, /Reinstall/);
      return true;
    },
  );
});

test('bindPlatformSkills binds registry-installed skills into existing host roots', async () => {
  const root = mkdtempTempRootSync('skill-bind-');
  const systemHome = root;
  const skillsRoot = path.join(systemHome, '.metabot', 'skills');
  const dshHome = path.join(systemHome, '.dsh');
  await fs.mkdir(dshHome, { recursive: true });

  const archive = await makeSkillZip(path.join(root, 'pkg'), { 'SKILL.md': skillDoc('community-skill', '1.0.0') });
  await installSkillArchive({ skillsRoot, archive, source: { creatorMetaId: 'IDQ1' } });

  const results = await bindPlatformSkills({ systemHomeDir: systemHome, env: { DSH_HOME: dshHome }, mode: 'auto' });
  const dsh = results.find((entry) => entry.platformId === 'dsh');
  assert.equal(dsh.status, 'bound');
  assert.ok(dsh.boundSkills.includes('community-skill'), 'registry skill binds without the metabot- prefix');
  const link = path.join(dshHome, 'skills', 'community-skill');
  const stat = await fs.lstat(link);
  assert.equal(stat.isSymbolicLink(), true);
});

test('writeInstalledSkillsRegistry is atomic: no temp residue and read-back round-trips', async () => {
  const root = mkdtempTempRootSync();
  const skillsRoot = path.join(root, 'skills');
  await writeInstalledSkillsRegistry(skillsRoot, {
    version: 1,
    skills: {
      'atomic-probe': {
        name: 'atomic-probe',
        version: '1.0.0',
        description: '',
        creatorMetaId: 'IDQ1',
        creatorName: '',
        sourcePinId: '',
        skillFileUri: '',
        installedAt: 1,
        updatedAt: 2,
        enabled: true,
      },
    },
  });
  const entries = await fs.readdir(skillsRoot);
  assert.equal(entries.some((entry) => entry.startsWith('installed-skills.json.tmp-')), false);
  const registry = await readInstalledSkillsRegistry(skillsRoot);
  assert.equal(registry.skills['atomic-probe'].version, '1.0.0');
});

test('sweepSkillInstallLeftovers removes staging dirs, restores vouched trash, and never resurrects uninstalled skills', async () => {
  const root = mkdtempTempRootSync();
  const skillsRoot = path.join(root, 'skills');

  // Interrupted extraction: staging dir is garbage.
  await fs.mkdir(path.join(skillsRoot, '.skill-install-deadbeef'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, '.skill-install-deadbeef', 'partial'), 'x', 'utf8');

  // Interrupted swap (crash between the two renames): old version in trash,
  // target missing, registry still vouches for the skill -> restore.
  const registry = await readInstalledSkillsRegistry(skillsRoot);
  registry.skills['crashed-swap'] = {
    name: 'crashed-swap',
    version: '1.0.0',
    description: '',
    creatorMetaId: 'IDQ1',
    creatorName: '',
    sourcePinId: '',
    skillFileUri: '',
    installedAt: 1,
    updatedAt: 1,
    enabled: true,
  };
  await writeInstalledSkillsRegistry(skillsRoot, registry);
  await fs.mkdir(path.join(skillsRoot, '.skill-trash', 'crashed-swap'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, '.skill-trash', 'crashed-swap', 'SKILL.md'), skillDoc('crashed-swap', '1.0.0'), 'utf8');

  // Post-swap cleanup leftover: target exists, trash is stale -> delete.
  await fs.mkdir(path.join(skillsRoot, 'already-replaced'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, 'already-replaced', 'SKILL.md'), skillDoc('already-replaced', '2.0.0'), 'utf8');
  await fs.mkdir(path.join(skillsRoot, '.skill-trash', 'already-replaced'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, '.skill-trash', 'already-replaced', 'SKILL.md'), skillDoc('already-replaced', '1.0.0'), 'utf8');

  // Trash without a registry entry and without a target: an uninstalled skill
  // must not be resurrected as a foreign directory.
  await fs.mkdir(path.join(skillsRoot, '.skill-trash', 'long-gone'), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, '.skill-trash', 'long-gone', 'SKILL.md'), skillDoc('long-gone', '1.0.0'), 'utf8');

  const outcome = await sweepSkillInstallLeftovers(skillsRoot);
  assert.deepEqual(outcome.removedStagingDirs, ['.skill-install-deadbeef']);
  assert.deepEqual(outcome.restoredSkills, ['crashed-swap']);
  assert.deepEqual(outcome.removedTrashEntries.sort(), ['already-replaced', 'long-gone'].sort());
  const restored = await fs.readFile(path.join(skillsRoot, 'crashed-swap', 'SKILL.md'), 'utf8');
  assert.match(restored, /crashed-swap/);
  assert.equal(await fs.stat(path.join(skillsRoot, '.skill-trash')).then(() => true, () => false), false);
});

test('installSkillArchive replaces through the trash root and leaves no leftovers', async () => {
  const root = mkdtempTempRootSync();
  const skillsRoot = path.join(root, 'skills');
  const creator = { creatorMetaId: 'IDQ1', creatorName: 'Pub' };
  await installSkillArchive({
    skillsRoot,
    archive: await makeSkillZip(path.join(root, 'v1'), { 'SKILL.md': skillDoc('swap-skill', '1.0.0') }),
    source: creator,
  });
  await installSkillArchive({
    skillsRoot,
    archive: await makeSkillZip(path.join(root, 'v2'), { 'SKILL.md': skillDoc('swap-skill', '2.0.0') }),
    source: creator,
  });

  const registry = await readInstalledSkillsRegistry(skillsRoot);
  assert.equal(registry.skills['swap-skill'].version, '2.0.0');
  const entries = await fs.readdir(skillsRoot);
  assert.equal(entries.includes('.skill-trash'), false);
  assert.equal(entries.some((entry) => entry.startsWith('.skill-install-')), false);
  const installed = await fs.readFile(path.join(skillsRoot, 'swap-skill', 'SKILL.md'), 'utf8');
  assert.match(installed, /version: 2\.0\.0/);
});

test('installSkillArchive warns on downgrades and stays quiet on upgrades', async () => {
  const root = mkdtempTempRootSync();
  const skillsRoot = path.join(root, 'skills');
  const creator = { creatorMetaId: 'IDQ1' };

  const upgraded = await installSkillArchive({
    skillsRoot,
    archive: await makeSkillZip(path.join(root, 'a'), { 'SKILL.md': skillDoc('versioned-skill', '1.9.0') }),
    source: creator,
  });
  assert.deepEqual(upgraded.warnings, []);

  const downgraded = await installSkillArchive({
    skillsRoot,
    archive: await makeSkillZip(path.join(root, 'b'), { 'SKILL.md': skillDoc('versioned-skill', '1.2.0') }),
    source: creator,
  });
  assert.equal(downgraded.version, '1.2.0');
  assert.equal(downgraded.previousVersion, '1.9.0');
  assert.equal(downgraded.warnings.length, 1);
  assert.match(downgraded.warnings[0], /Downgrade: versioned-skill v1\.2\.0 replaces the installed v1\.9\.0/);
});

test('concurrent installs of different skills serialize on the per-root lock and both land', async () => {
  const root = mkdtempTempRootSync();
  const skillsRoot = path.join(root, 'skills');
  const [left, right] = await Promise.all([
    installSkillArchive({
      skillsRoot,
      archive: await makeSkillZip(path.join(root, 'left-pkg'), { 'SKILL.md': skillDoc('lock-left', '1.0.0') }),
      source: { creatorMetaId: 'IDQ1' },
    }),
    installSkillArchive({
      skillsRoot,
      archive: await makeSkillZip(path.join(root, 'right-pkg'), { 'SKILL.md': skillDoc('lock-right', '1.0.0') }),
      source: { creatorMetaId: 'IDQ1' },
    }),
  ]);
  assert.equal(left.name, 'lock-left');
  assert.equal(right.name, 'lock-right');
  const registry = await readInstalledSkillsRegistry(skillsRoot);
  assert.ok(registry.skills['lock-left']);
  assert.ok(registry.skills['lock-right']);
  assert.equal(await fs.stat(path.join(skillsRoot, '.skill-install.lock')).then(() => true, () => false), false);
});
