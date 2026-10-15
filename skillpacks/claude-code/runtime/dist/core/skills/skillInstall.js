"use strict";
/**
 * On-chain skill package installation — OAC port of the IDBots
 * skillInstallService consumer half. A `metabot-skill` protocol pin points at
 * a zip package (`skill-file: metafile://<pinId>.zip`); this module downloads
 * that archive, verifies it against the pin's `sha256` when present, extracts
 * it safely, and installs it as a regular skill
 * directory under the shared skills root (`~/.metabot/skills/<name>/`),
 * recording provenance in the installed-skills registry so host skill
 * binding can pick it up like any local skill.
 *
 * Everything here is untrusted third-party input: the archive size is capped,
 * extraction reuses the zip-slip-guarded MetaApp extractor, and skill names
 * are validated before they become directory names.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillInstallError = exports.SKILL_REGISTRY_FILENAME = exports.MAX_SKILL_PACKAGE_BYTES = void 0;
exports.normalizeSkillName = normalizeSkillName;
exports.readBlockScalarValue = readBlockScalarValue;
exports.parseSkillFrontmatter = parseSkillFrontmatter;
exports.extractSkillPinDescriptor = extractSkillPinDescriptor;
exports.downloadSkillArchive = downloadSkillArchive;
exports.readInstalledSkillsRegistry = readInstalledSkillsRegistry;
exports.writeInstalledSkillsRegistry = writeInstalledSkillsRegistry;
exports.sweepSkillInstallLeftovers = sweepSkillInstallLeftovers;
exports.installSkillArchive = installSkillArchive;
exports.installSkillFromReference = installSkillFromReference;
exports.listInstalledSkills = listInstalledSkills;
exports.readInstalledSkill = readInstalledSkill;
exports.uninstallInstalledSkill = uninstallInstalledSkill;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const artifactDownload_1 = require("../metaapp/artifactDownload");
const zipArchive_1 = require("../metaapp/zipArchive");
/** Parity with IDBots MAX_SKILL_PACKAGE_BYTES — the published zip must stay small. */
exports.MAX_SKILL_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_EXTRACTED_ENTRIES = 500;
const MAX_EXTRACTED_BYTES = 16 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
/** Registry file inside the shared skills root; one entry per chain-installed skill. */
exports.SKILL_REGISTRY_FILENAME = 'installed-skills.json';
const SKILL_DOC_FILENAMES = ['SKILL.md', 'skill.md', 'Skill.md'];
const SKILL_STAGING_PREFIX = '.skill-install-';
const SKILL_TRASH_DIRNAME = '.skill-trash';
const SKILL_LOCK_FILENAME = '.skill-install.lock';
/** Installs take seconds; a lock older than this is a crashed holder. */
const SKILL_LOCK_STALE_MS = 5 * 60_000;
const SKILL_LOCK_SPIN_MS = 100;
const SKILL_LOCK_MAX_SPINS = 600;
class SkillInstallError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SkillInstallError';
        this.code = code;
    }
}
exports.SkillInstallError = SkillInstallError;
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** Directory-safe skill name: must round-trip as a single path segment. */
function normalizeSkillName(value) {
    const name = normalizeText(value);
    if (!name || name.length > 64)
        return '';
    if (name === '.' || name === '..' || name.startsWith('.'))
        return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
        return '';
    return name;
}
const BLOCK_SCALAR_INDICATOR_PATTERN = /^([|>])([-+]?)$/;
function leadingIndent(line) {
    return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}
/**
 * Test seam for `parseSkillFrontmatter`: read the literal (`|`) or folded (`>`)
 * block scalar whose indicator sits on the line before `startIndex`, and unfold
 * it with the optional `-`/`+` chomping indicator.
 *
 * The body is every following line that is blank or indented deeper than the
 * key; the indentation to strip is that of the first non-empty body line.
 * `lines` uses the frontmatter line convention, where the line break before the
 * closing `---` is represented by a final empty entry: `-` drops the trailing
 * break, the default keeps exactly one, and `+` keeps every trailing blank line.
 */
function readBlockScalarValue(lines, startIndex, keyIndent, style, chomping) {
    const rawBody = [];
    let lastLineIndex = startIndex - 1;
    for (let index = startIndex; index < lines.length; index += 1) {
        const rawLine = lines[index];
        if (rawLine.trim() !== '' && leadingIndent(rawLine) <= keyIndent)
            break;
        rawBody.push(rawLine);
        lastLineIndex = index;
    }
    const firstContentLine = rawBody.find((rawLine) => rawLine.trim() !== '');
    const bodyIndent = firstContentLine === undefined ? 0 : leadingIndent(firstContentLine);
    const body = rawBody.map((rawLine) => (rawLine.trim() === '' ? '' : rawLine.slice(Math.min(bodyIndent, leadingIndent(rawLine)))));
    let trailingBlankCount = 0;
    while (trailingBlankCount < body.length && body[body.length - 1 - trailingBlankCount] === '') {
        trailingBlankCount += 1;
    }
    const contentLines = body.slice(0, body.length - trailingBlankCount);
    const content = (style === '>' ? contentLines.join(' ') : contentLines.join('\n'));
    if (!content)
        return { value: '', lastLineIndex };
    if (chomping === '-')
        return { value: content, lastLineIndex };
    if (chomping === '+')
        return { value: content + '\n'.repeat(trailingBlankCount), lastLineIndex };
    return { value: `${content}\n`, lastLineIndex };
}
/**
 * Minimal YAML frontmatter scan for the fields installation needs. Flat
 * scalars are read directly; literal (`|`) and folded (`>`) block scalars are
 * unfolded, and a value that is only a block indicator without a body counts
 * as absent so the pin payload can supply it. Nested keys are ignored rather
 * than mis-parsed.
 */
function parseSkillFrontmatter(markdown) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
    if (!match)
        return {};
    // Keep the break before the closing `---` as a final empty line so the
    // block-scalar chomping indicators count line breaks the way YAML does.
    const lines = `${match[1]}\n`.split(/\r?\n/);
    const fields = {};
    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const separator = line.indexOf(':');
        if (separator <= 0)
            continue;
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z0-9_-]+$/.test(key))
            continue;
        const rawValue = line.slice(separator + 1).trim();
        const indicator = BLOCK_SCALAR_INDICATOR_PATTERN.exec(rawValue);
        let value;
        if (indicator) {
            const block = readBlockScalarValue(lines, index + 1, leadingIndent(rawLine), indicator[1], indicator[2]);
            index = block.lastLineIndex;
            value = block.value;
        }
        else {
            value = rawValue;
            if (/^["'](.*)["']$/.test(value) && value.length >= 2) {
                value = value.slice(1, -1);
            }
        }
        if (value && !fields[key])
            fields[key] = value;
    }
    const picked = {};
    for (const key of ['name', 'version', 'description']) {
        const value = normalizeText(fields[key]);
        if (value)
            picked[key] = value;
    }
    return picked;
}
/**
 * Read the install descriptor out of a `metabot-skill` protocol pin record
 * (as returned by the pin-read API). Accepts the payload field spellings
 * seen across publishers, matching the IDBots protocolPinContent parser.
 */
function extractSkillPinDescriptor(pin) {
    const payload = pin.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const record = payload;
    const name = normalizeText(record.name ?? record.skillName ?? record.id);
    const skillFileUri = normalizeText(record['skill-file'] ?? record.skillFileUri ?? record.skill_file_uri ?? record.uri);
    if (!name || !skillFileUri)
        return null;
    return {
        name,
        description: normalizeText(record.description),
        version: normalizeText(record.version ?? record.skillVersion) || '0',
        skillFileUri,
        sha256: normalizeText(record.sha256).toLowerCase(),
    };
}
/**
 * Download a skill package archive. `contentReference` is the pin payload's
 * package URI (`metafile://<pinId>[.zip]`) or a plain https URL; resolution
 * and URL fallbacks reuse the MetaApp artifact download path.
 */
async function downloadSkillArchive(input) {
    const reference = normalizeText(input.contentReference);
    const urls = (0, artifactDownload_1.metaAppArchiveUrls)(reference);
    if (!urls.length) {
        throw new SkillInstallError('invalid_source', `The skill package reference is not downloadable: ${reference || '(empty)'} — expected metafile://<pinId> or an https URL.`);
    }
    const maxBytes = input.maxBytes ?? exports.MAX_SKILL_PACKAGE_BYTES;
    const timeoutMs = input.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const expectedSha256 = normalizeText(input.expectedSha256).toLowerCase();
    const failures = [];
    for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await input.fetchImpl(url, { signal: controller.signal });
            if (!response?.ok) {
                failures.push(`${url} → HTTP ${response?.status ?? 'network error'}`);
                continue;
            }
            const declaredLength = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
                throw new SkillInstallError('invalid_package', `Skill package exceeds the ${Math.round(maxBytes / 1024)} KB cap (${Math.round(declaredLength / 1024)} KB): ${reference}`);
            }
            const archive = Buffer.from(await response.arrayBuffer());
            if (archive.byteLength === 0) {
                failures.push(`${url} → empty body`);
                continue;
            }
            if (archive.byteLength > maxBytes) {
                throw new SkillInstallError('invalid_package', `Skill package exceeds the ${Math.round(maxBytes / 1024)} KB cap (${Math.round(archive.byteLength / 1024)} KB): ${reference}`);
            }
            if (expectedSha256) {
                const actualSha256 = (0, node_crypto_1.createHash)('sha256').update(archive).digest('hex');
                if (actualSha256 !== expectedSha256) {
                    throw new SkillInstallError('digest_mismatch', `Skill package digest mismatch for ${reference}: the pin advertises sha256 ${expectedSha256} but the download hashes to ${actualSha256}. The archive may be corrupted or tampered with; refusing to install.`);
                }
            }
            return archive;
        }
        catch (error) {
            if (error instanceof SkillInstallError)
                throw error;
            failures.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            clearTimeout(timer);
        }
    }
    throw new SkillInstallError('download_failed', `Skill package could not be downloaded (${reference}): ${failures.join('; ')}`);
}
async function fileExists(filePath) {
    try {
        const stat = await node_fs_1.promises.stat(filePath);
        return stat.isFile();
    }
    catch {
        return false;
    }
}
/** SKILL.md at the archive root, or exactly one wrapping directory, else the shallowest match anywhere. */
async function locateSkillDoc(rootDir) {
    for (const candidate of SKILL_DOC_FILENAMES) {
        if (await fileExists(node_path_1.default.join(rootDir, candidate))) {
            return node_path_1.default.join(rootDir, candidate);
        }
    }
    const entries = await node_fs_1.promises.readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX');
    if (directories.length === 1) {
        const nested = node_path_1.default.join(rootDir, directories[0].name);
        for (const candidate of SKILL_DOC_FILENAMES) {
            if (await fileExists(node_path_1.default.join(nested, candidate))) {
                return node_path_1.default.join(nested, candidate);
            }
        }
    }
    // Shallowest-first fallback for archives that nest deeper.
    let queue = [rootDir];
    while (queue.length) {
        const next = [];
        for (const dir of queue) {
            const inner = await node_fs_1.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of inner) {
                const entryPath = node_path_1.default.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX') {
                    next.push(entryPath);
                }
                else if (entry.isFile() && SKILL_DOC_FILENAMES.includes(entry.name)) {
                    return entryPath;
                }
            }
        }
        queue = next;
    }
    return null;
}
async function listFilesRelative(rootDir, dir = rootDir) {
    const entries = await node_fs_1.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
        const entryPath = node_path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listFilesRelative(rootDir, entryPath));
        }
        else if (entry.isFile()) {
            files.push(node_path_1.default.relative(rootDir, entryPath).split(node_path_1.default.sep).join('/'));
        }
    }
    return files.sort();
}
function registryPath(skillsRoot) {
    return node_path_1.default.join(skillsRoot, exports.SKILL_REGISTRY_FILENAME);
}
async function readInstalledSkillsRegistry(skillsRoot) {
    let raw;
    try {
        raw = JSON.parse(await node_fs_1.promises.readFile(registryPath(skillsRoot), 'utf8'));
    }
    catch {
        return { version: 1, skills: {} };
    }
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const skillsInput = record.skills && typeof record.skills === 'object' && !Array.isArray(record.skills)
        ? record.skills
        : {};
    const skills = {};
    for (const [key, value] of Object.entries(skillsInput)) {
        const entry = value && typeof value === 'object' ? value : null;
        const name = normalizeText(entry?.name) || key;
        if (!normalizeSkillName(name))
            continue;
        skills[name] = {
            name,
            version: normalizeText(entry?.version),
            description: normalizeText(entry?.description),
            creatorMetaId: normalizeText(entry?.creatorMetaId),
            creatorName: normalizeText(entry?.creatorName),
            sourcePinId: normalizeText(entry?.sourcePinId),
            skillFileUri: normalizeText(entry?.skillFileUri),
            installedAt: Number(entry?.installedAt) || 0,
            updatedAt: Number(entry?.updatedAt) || 0,
            enabled: entry?.enabled !== false,
        };
    }
    return { version: 1, skills };
}
/**
 * Write the registry atomically: a half-written file must never become the
 * registry, because a corrupt read degrades to "nothing installed" and locks
 * the user out of reinstalling (the on-disk dirs then count as foreign).
 */
async function writeInstalledSkillsRegistry(skillsRoot, registry) {
    await node_fs_1.promises.mkdir(skillsRoot, { recursive: true });
    const target = registryPath(skillsRoot);
    const tempPath = `${target}.tmp-${(0, node_crypto_1.randomUUID)()}`;
    try {
        const handle = await node_fs_1.promises.open(tempPath, 'w');
        try {
            await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await node_fs_1.promises.rename(tempPath, target);
    }
    catch (error) {
        await node_fs_1.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
/**
 * Serialize installs and uninstalls per skills root (cross-process: CLI
 * invocations from several agents can race on the registry and skill dirs).
 * An exclusively-created lock file is released on completion; a lock older
 * than the stale window belongs to a crashed holder and is stolen.
 */
async function withSkillInstallLock(skillsRoot, run) {
    await node_fs_1.promises.mkdir(skillsRoot, { recursive: true });
    const lockPath = node_path_1.default.join(node_path_1.default.resolve(skillsRoot), SKILL_LOCK_FILENAME);
    for (let spin = 0;; spin += 1) {
        let acquired = false;
        try {
            const handle = await node_fs_1.promises.open(lockPath, 'wx');
            try {
                await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8');
            }
            finally {
                await handle.close();
            }
            acquired = true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        if (acquired) {
            try {
                return await run();
            }
            finally {
                await node_fs_1.promises.rm(lockPath, { force: true }).catch(() => undefined);
            }
        }
        try {
            const stat = await node_fs_1.promises.stat(lockPath);
            if (Date.now() - stat.mtimeMs > SKILL_LOCK_STALE_MS) {
                await node_fs_1.promises.rm(lockPath, { force: true });
                continue;
            }
        }
        catch {
            // The holder released between our failed acquire and this stat — retry.
        }
        if (spin >= SKILL_LOCK_MAX_SPINS) {
            throw new SkillInstallError('install_locked', `Another skill install has held ${lockPath} for over a minute; retry shortly.`);
        }
        await new Promise((resolve) => setTimeout(resolve, SKILL_LOCK_SPIN_MS));
    }
}
/**
 * Remove interrupted-install leftovers under the skills root:
 * - staging directories (`.skill-install-*`) from extractions that never
 *   reached the swap — safe to delete;
 * - registry temp files from atomic writes that never renamed;
 * - swap trash (`.skill-trash/<name>`): when the skill never landed on the
 *   main root the swap crashed between its two renames, so restore the
 *   previous version (the registry still vouches for it); otherwise the new
 *   version is in place and the trash is a post-swap cleanup leftover.
 */
async function sweepSkillInstallLeftovers(skillsRoot) {
    const root = node_path_1.default.resolve(skillsRoot);
    const removedStagingDirs = [];
    const restoredSkills = [];
    const removedTrashEntries = [];
    let entries = [];
    try {
        entries = await node_fs_1.promises.readdir(root, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { removedStagingDirs, restoredSkills, removedTrashEntries };
        }
        throw error;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(SKILL_STAGING_PREFIX)) {
            await node_fs_1.promises.rm(node_path_1.default.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined);
            removedStagingDirs.push(entry.name);
        }
        if (!entry.isDirectory() && entry.name.startsWith(`${exports.SKILL_REGISTRY_FILENAME}.tmp-`)) {
            await node_fs_1.promises.rm(node_path_1.default.join(root, entry.name), { force: true }).catch(() => undefined);
        }
    }
    const trashRoot = node_path_1.default.join(root, SKILL_TRASH_DIRNAME);
    let trashEntries = [];
    try {
        trashEntries = await node_fs_1.promises.readdir(trashRoot, { withFileTypes: true });
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    if (!trashEntries.length)
        return { removedStagingDirs, restoredSkills, removedTrashEntries };
    const registry = await readInstalledSkillsRegistry(root);
    for (const entry of trashEntries) {
        if (!entry.isDirectory())
            continue;
        const trashDir = node_path_1.default.join(trashRoot, entry.name);
        const targetDir = node_path_1.default.join(root, entry.name);
        const targetExists = await node_fs_1.promises.stat(targetDir).then(() => true, () => false);
        // Restore only registry-vouched skills: a trash entry without a registry
        // record would resurrect an already-uninstalled skill as a foreign dir.
        if (!targetExists && registry.skills[entry.name]) {
            try {
                await node_fs_1.promises.rename(trashDir, targetDir);
                restoredSkills.push(entry.name);
                continue;
            }
            catch {
                // Fall through to removal.
            }
        }
        await node_fs_1.promises.rm(trashDir, { recursive: true, force: true }).catch(() => undefined);
        removedTrashEntries.push(entry.name);
    }
    await node_fs_1.promises.rmdir(trashRoot).catch(() => undefined);
    return { removedStagingDirs, restoredSkills, removedTrashEntries };
}
/**
 * Install an already-downloaded skill package archive under the shared skills
 * root. Existing installations of the same name are replaced in place (same
 * publisher or explicit override); a name owned by a different publisher or
 * by a non-registry local skill is a conflict, not a clobber. The whole
 * mutation runs under the per-root install lock, after sweeping leftovers
 * from previously interrupted installs.
 */
async function installSkillArchive(input) {
    return withSkillInstallLock(input.skillsRoot, () => installSkillArchiveLocked(input));
}
async function installSkillArchiveLocked(input) {
    const skillsRoot = node_path_1.default.resolve(input.skillsRoot);
    const now = input.now ?? Date.now;
    const stagingRoot = node_path_1.default.join(skillsRoot, `${SKILL_STAGING_PREFIX}${(0, node_crypto_1.randomUUID)()}`);
    await node_fs_1.promises.mkdir(skillsRoot, { recursive: true });
    await sweepSkillInstallLeftovers(skillsRoot).catch(() => undefined);
    let extracted;
    try {
        extracted = await (0, zipArchive_1.extractMetaAppZipArchive)({
            archive: input.archive,
            outDir: stagingRoot,
            maxEntries: MAX_EXTRACTED_ENTRIES,
            maxUncompressedBytes: MAX_EXTRACTED_BYTES,
        });
    }
    catch (error) {
        await node_fs_1.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw new SkillInstallError('invalid_package', `Skill package could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        const skillDocPath = await locateSkillDoc(stagingRoot);
        if (!skillDocPath) {
            throw new SkillInstallError('invalid_package', 'Skill package has no SKILL.md — not an installable metabot-skill package.');
        }
        const packageRoot = node_path_1.default.dirname(skillDocPath);
        const markdown = await node_fs_1.promises.readFile(skillDocPath, 'utf8');
        const frontmatter = parseSkillFrontmatter(markdown);
        const name = normalizeSkillName(frontmatter.name ?? input.source?.payloadName);
        if (!name) {
            throw new SkillInstallError('invalid_package', 'Skill package has no usable name (SKILL.md frontmatter `name` or pin payload `name` is required).');
        }
        const registry = await readInstalledSkillsRegistry(skillsRoot);
        const existing = registry.skills[name];
        const targetDir = node_path_1.default.join(skillsRoot, name);
        const targetExists = await node_fs_1.promises.stat(targetDir).then(() => true, () => false);
        const incomingCreator = normalizeText(input.source?.creatorMetaId);
        if (!input.force) {
            if (existing && incomingCreator && existing.creatorMetaId && existing.creatorMetaId !== incomingCreator) {
                throw new SkillInstallError('name_conflict', `Skill "${name}" is already installed from a different publisher (${existing.creatorMetaId}); refusing to replace it. Uninstall it first or pass --force.`);
            }
            if (targetExists && !existing) {
                throw new SkillInstallError('name_conflict', `A local skill named "${name}" already exists at ${targetDir} and was not installed from MetaWeb; refusing to replace it. Remove it first or pass --force.`);
            }
        }
        const version = normalizeText(frontmatter.version ?? input.source?.payloadVersion) || '0';
        const description = normalizeText(frontmatter.description ?? input.source?.payloadDescription);
        const warnings = [];
        if (existing?.version && version !== existing.version && compareSkillVersions(version, existing.version) < 0) {
            warnings.push(`Downgrade: ${name} v${version} replaces the installed v${existing.version}. Install the latest pin to keep the newer version.`);
        }
        // Crash-safe swap: displace the old directory into the trash root first,
        // so a crash leaves the old or the new version in place — never neither.
        // The next install's sweep (or any sweep) restores a trashed skill whose
        // replacement never landed.
        const trashDir = node_path_1.default.join(skillsRoot, SKILL_TRASH_DIRNAME, name);
        let displaced = false;
        if (targetExists) {
            await node_fs_1.promises.mkdir(node_path_1.default.dirname(trashDir), { recursive: true });
            await node_fs_1.promises.rm(trashDir, { recursive: true, force: true });
            await node_fs_1.promises.rename(targetDir, trashDir);
            displaced = true;
        }
        try {
            await node_fs_1.promises.rename(packageRoot, targetDir);
        }
        catch (error) {
            if (displaced)
                await node_fs_1.promises.rename(trashDir, targetDir).catch(() => undefined);
            throw error;
        }
        if (displaced) {
            await node_fs_1.promises.rm(trashDir, { recursive: true, force: true }).catch(() => undefined);
            // Drop the trash root too when this was its last entry.
            await node_fs_1.promises.rmdir(node_path_1.default.dirname(trashDir)).catch(() => undefined);
        }
        const record = {
            name,
            version,
            description,
            creatorMetaId: incomingCreator,
            creatorName: normalizeText(input.source?.creatorName),
            sourcePinId: normalizeText(input.source?.sourcePinId),
            skillFileUri: normalizeText(input.source?.skillFileUri),
            installedAt: existing?.installedAt || now(),
            updatedAt: now(),
            enabled: true,
        };
        registry.skills[name] = record;
        await writeInstalledSkillsRegistry(skillsRoot, registry);
        return {
            name,
            version,
            description,
            skillDir: targetDir,
            skillMdPath: node_path_1.default.join(targetDir, node_path_1.default.basename(skillDocPath)),
            replaced: Boolean(existing) || targetExists,
            previousVersion: existing?.version || null,
            files: await listFilesRelative(targetDir),
            warnings,
        };
    }
    finally {
        await node_fs_1.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
/**
 * Loose dot-numeric compare for skill versions ('0', '1.2', '1.2.3',
 * '2026.5.5'): numeric segments compare numerically, anything else falls back
 * to a lexicographic segment compare. Returns <0 when left is older.
 */
function compareSkillVersions(left, right) {
    const leftSegments = left.split('.');
    const rightSegments = right.split('.');
    const length = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < length; index += 1) {
        const leftSegment = leftSegments[index];
        const rightSegment = rightSegments[index];
        if (leftSegment === undefined)
            return -1;
        if (rightSegment === undefined)
            return 1;
        const leftNumber = /^\d+$/.test(leftSegment) ? Number(leftSegment) : undefined;
        const rightNumber = /^\d+$/.test(rightSegment) ? Number(rightSegment) : undefined;
        if (leftNumber !== undefined && rightNumber !== undefined) {
            if (leftNumber !== rightNumber)
                return leftNumber - rightNumber;
            continue;
        }
        const order = leftSegment.localeCompare(rightSegment);
        if (order !== 0)
            return order < 0 ? -1 : 1;
    }
    return 0;
}
/** Full flow: download the package archive (verifying the pin's digest when advertised), then install it. */
async function installSkillFromReference(input) {
    const archive = await downloadSkillArchive({
        contentReference: input.contentReference,
        fetchImpl: input.fetchImpl,
        maxBytes: input.maxBytes,
        expectedSha256: input.source?.payloadSha256,
    });
    return installSkillArchive({
        skillsRoot: input.skillsRoot,
        archive,
        source: {
            ...input.source,
            skillFileUri: input.source?.skillFileUri || normalizeText(input.contentReference),
        },
        force: input.force,
        now: input.now,
    });
}
/** Registry view enriched with on-disk presence, for `skills list`. */
async function listInstalledSkills(skillsRoot) {
    const registry = await readInstalledSkillsRegistry(skillsRoot);
    const entries = Object.values(registry.skills).sort((left, right) => left.name.localeCompare(right.name));
    return Promise.all(entries.map(async (entry) => ({
        ...entry,
        present: await fileExists(node_path_1.default.join(skillsRoot, entry.name, 'SKILL.md'))
            || await fileExists(node_path_1.default.join(skillsRoot, entry.name, 'skill.md')),
    })));
}
/** Load one installed skill's SKILL.md and file listing, for `skills read`. */
async function readInstalledSkill(input) {
    const name = normalizeSkillName(input.name);
    if (!name) {
        throw new SkillInstallError('invalid_package', `Invalid skill name: ${input.name}`);
    }
    const skillDir = node_path_1.default.join(node_path_1.default.resolve(input.skillsRoot), name);
    for (const candidate of SKILL_DOC_FILENAMES) {
        const skillMdPath = node_path_1.default.join(skillDir, candidate);
        if (await fileExists(skillMdPath)) {
            return {
                name,
                skillDir,
                skillMdPath,
                skillMd: await node_fs_1.promises.readFile(skillMdPath, 'utf8'),
                files: await listFilesRelative(skillDir),
            };
        }
    }
    // Distinguish "never installed" from "installed but corrupt" — one shared
    // "No SKILL.md found" line read like package corruption and gave no way
    // forward (N-3).
    const dirExists = await node_fs_1.promises.stat(skillDir).then(() => true, () => false);
    const registry = await readInstalledSkillsRegistry(input.skillsRoot);
    if (!dirExists && !registry.skills[name]) {
        throw new SkillInstallError('invalid_package', `Skill "${name}" is not installed locally. Install it from its on-chain package first: read the skill pin for its pinId (or metafile URI), then run \`metabot skills install --pin <pinId> --confirm\` (agents: skill_tool install_skill).`);
    }
    throw new SkillInstallError('invalid_package', `Skill "${name}" is installed under ${skillDir} but its SKILL.md is missing — the package is corrupt. Reinstall it (\`metabot skills install --pin <pinId> --confirm --force\`, or uninstall then install again).`);
}
/** Remove one chain-installed skill (registry entry + directory). Built-in/local skills are refused. */
async function uninstallInstalledSkill(input) {
    return withSkillInstallLock(input.skillsRoot, () => uninstallInstalledSkillLocked(input));
}
async function uninstallInstalledSkillLocked(input) {
    const name = normalizeSkillName(input.name);
    if (!name) {
        throw new SkillInstallError('invalid_package', `Invalid skill name: ${input.name}`);
    }
    const registry = await readInstalledSkillsRegistry(input.skillsRoot);
    if (!registry.skills[name]) {
        throw new SkillInstallError('name_conflict', `Skill "${name}" was not installed from MetaWeb (no registry entry); remove local skills manually.`);
    }
    const skillDir = node_path_1.default.join(node_path_1.default.resolve(input.skillsRoot), name);
    const removedDir = await node_fs_1.promises.stat(skillDir).then(() => true, () => false);
    if (removedDir) {
        await node_fs_1.promises.rm(skillDir, { recursive: true, force: true });
    }
    delete registry.skills[name];
    await writeInstalledSkillsRegistry(input.skillsRoot, registry);
    return { name, removedDir };
}
