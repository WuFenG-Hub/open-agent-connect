"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeSettingsPath = claudeSettingsPath;
exports.planClaudeHookInstall = planClaudeHookInstall;
exports.installClaudeHooks = installClaudeHooks;
exports.uninstallClaudeHooks = uninstallClaudeHooks;
exports.doctorClaudeHooks = doctorClaudeHooks;
/**
 * Claude Code managed-hook installer. Owns entries in `~/.claude/settings.json`
 * by construction: every managed hook command references the
 * `metabot-claude-hook.sh` script, and install/uninstall only ever touch
 * commands containing that file name — user-added hooks are preserved
 * verbatim. Writes are atomic with a single rolling backup, and skipped
 * entirely when the bytes are unchanged so repeated installs don't roll the
 * backup forward.
 */
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const claudeHookScript_1 = require("./claudeHookScript");
const HOOK_TIMEOUT_SECONDS = 10;
/** Events without a matcher (fires for every occurrence). */
const BARE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop'];
/** Tool-scoped events (matcher "*"). */
const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];
function claudeSettingsPath(homeDir = node_os_1.default.homedir()) {
    return node_path_1.default.join(homeDir, '.claude', 'settings.json');
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
async function readSettings(settingsPath) {
    try {
        const raw = await node_fs_1.promises.readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? { doc: parsed, existed: true } : { doc: {}, existed: true };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return { doc: {}, existed: false };
        throw new Error(`Claude Code settings at ${settingsPath} are not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function hookCommand(scriptPath) {
    return `if [ -f '${scriptPath}' ]; then /bin/sh '${scriptPath}'; else printf '{}\\n'; fi`;
}
function buildManagedHookEntries(scriptPath) {
    return [
        ...BARE_EVENTS.map((event) => ({ event })),
        ...MATCHER_EVENTS.map((event) => ({ event, matcher: '*' })),
    ];
}
/**
 * Remove managed commands from a settings doc in place; returns true when
 * anything changed. Only commands containing the managed script name are
 * touched.
 */
function removeManagedCommands(doc, scriptPath) {
    const hooks = doc.hooks;
    if (!isRecord(hooks))
        return false;
    let changed = false;
    for (const event of Object.keys(hooks)) {
        const groups = hooks[event];
        if (!Array.isArray(groups))
            continue;
        const keptGroups = groups.filter((group) => {
            if (!isRecord(group))
                return true;
            const entries = group.hooks;
            if (!Array.isArray(entries))
                return true;
            const kept = entries.filter((entry) => !(isRecord(entry) && typeof entry.command === 'string' && (0, claudeHookScript_1.isManagedClaudeHookCommand)(entry.command)));
            if (kept.length === entries.length)
                return true;
            changed = true;
            if (kept.length === 0)
                return false;
            group.hooks = kept;
            return true;
        });
        if (keptGroups.length !== groups.length) {
            changed = true;
            if (keptGroups.length === 0)
                delete hooks[event];
            else
                hooks[event] = keptGroups;
        }
    }
    if (Object.keys(hooks).length === 0)
        delete doc.hooks;
    return changed;
}
function hasManagedCommands(doc) {
    const hooks = doc.hooks;
    if (!isRecord(hooks))
        return false;
    for (const groups of Object.values(hooks)) {
        if (!Array.isArray(groups))
            continue;
        for (const group of groups) {
            if (!isRecord(group) || !Array.isArray(group.hooks))
                continue;
            for (const entry of group.hooks) {
                if (isRecord(entry) && typeof entry.command === 'string' && (0, claudeHookScript_1.isManagedClaudeHookCommand)(entry.command))
                    return true;
            }
        }
    }
    return false;
}
async function writeSettingsAtomic(settingsPath, doc) {
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    const temp = `${settingsPath}.tmp-${(0, node_crypto_1.randomUUID)()}`;
    await node_fs_1.promises.writeFile(temp, body, 'utf8');
    await node_fs_1.promises.rename(temp, settingsPath);
}
async function planClaudeHookInstall(input) {
    const settingsPath = claudeSettingsPath(input.homeDir);
    const { doc, existed } = await readSettings(settingsPath);
    return {
        settingsPath,
        scriptPath: (0, claudeHookScript_1.claudeHookScriptPath)(input.agentsDir),
        events: [...BARE_EVENTS, ...MATCHER_EVENTS],
        settingsExisted: existed,
        alreadyInstalled: hasManagedCommands(doc),
        existingUserHookEvents: Object.keys(isRecord(doc.hooks) ? doc.hooks : {}),
    };
}
async function installClaudeHooks(input) {
    const plan = await planClaudeHookInstall(input);
    await node_fs_1.promises.mkdir(input.agentsDir, { recursive: true, mode: 0o700 });
    const scriptPath = (0, claudeHookScript_1.claudeHookScriptPath)(input.agentsDir);
    const tempScript = `${scriptPath}.tmp-${(0, node_crypto_1.randomUUID)()}`;
    await node_fs_1.promises.writeFile(tempScript, (0, claudeHookScript_1.renderClaudeHookScript)(input.agentsDir), 'utf8');
    await node_fs_1.promises.chmod(tempScript, 0o755);
    await node_fs_1.promises.rename(tempScript, scriptPath);
    const { doc } = await readSettings(plan.settingsPath);
    const before = JSON.stringify(doc);
    removeManagedCommands(doc, scriptPath);
    const hooks = (isRecord(doc.hooks) ? doc.hooks : (doc.hooks = {}));
    for (const { event, matcher } of buildManagedHookEntries(scriptPath)) {
        const groups = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
        groups.push(matcher
            ? { matcher, hooks: [{ type: 'command', command: hookCommand(scriptPath), timeout: HOOK_TIMEOUT_SECONDS }] }
            : { hooks: [{ type: 'command', command: hookCommand(scriptPath), timeout: HOOK_TIMEOUT_SECONDS }] });
    }
    const backupPath = `${plan.settingsPath}.bak`;
    if (before !== JSON.stringify(doc)) {
        try {
            await node_fs_1.promises.copyFile(plan.settingsPath, backupPath);
        }
        catch {
            // First install: nothing to back up.
        }
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(plan.settingsPath), { recursive: true });
        await writeSettingsAtomic(plan.settingsPath, doc);
    }
    return { ...plan, changed: before !== JSON.stringify(doc), backupPath };
}
async function uninstallClaudeHooks(input) {
    const settingsPath = claudeSettingsPath(input.homeDir);
    const { doc } = await readSettings(settingsPath);
    const before = JSON.stringify(doc);
    const changed = removeManagedCommands(doc, (0, claudeHookScript_1.claudeHookScriptPath)(input.agentsDir));
    if (changed) {
        try {
            await node_fs_1.promises.copyFile(settingsPath, `${settingsPath}.bak`);
        }
        catch {
            // Nothing to back up.
        }
        await writeSettingsAtomic(settingsPath, doc);
    }
    let removedScript = false;
    try {
        await node_fs_1.promises.rm((0, claudeHookScript_1.claudeHookScriptPath)(input.agentsDir), { force: true });
        removedScript = true;
    }
    catch {
        // Best effort.
    }
    return { settingsPath, changed, removedScript };
}
async function doctorClaudeHooks(input) {
    const plan = await planClaudeHookInstall(input);
    let scriptPresent = false;
    try {
        await node_fs_1.promises.access((0, claudeHookScript_1.claudeHookScriptPath)(input.agentsDir));
        scriptPresent = true;
    }
    catch {
        scriptPresent = false;
    }
    const endpoint = await Promise.resolve().then(() => __importStar(require('./agentHookEndpoint'))).then((module) => module.readAgentHookEndpointFile(input.agentsDir));
    return {
        settingsPath: plan.settingsPath,
        scriptPath: plan.scriptPath,
        settingsExisted: plan.settingsExisted,
        installed: plan.alreadyInstalled,
        events: plan.alreadyInstalled ? plan.events : [],
        existingUserHookEvents: plan.existingUserHookEvents,
        scriptPresent,
        endpointPublished: Boolean(endpoint),
    };
}
