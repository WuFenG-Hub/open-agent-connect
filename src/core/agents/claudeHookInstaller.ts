/**
 * Claude Code managed-hook installer. Owns entries in `~/.claude/settings.json`
 * by construction: every managed hook command references the
 * `metabot-claude-hook.sh` script, and install/uninstall only ever touch
 * commands containing that file name — user-added hooks are preserved
 * verbatim. Writes are atomic with a single rolling backup, and skipped
 * entirely when the bytes are unchanged so repeated installs don't roll the
 * backup forward.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeHookScriptPath, isManagedClaudeHookCommand, renderClaudeHookScript } from './claudeHookScript';

const HOOK_TIMEOUT_SECONDS = 10;

/** Events without a matcher (fires for every occurrence). */
const BARE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop'] as const;
/** Tool-scoped events (matcher "*"). */
const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'] as const;

export function claudeSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

export interface ClaudeHookInstallPlan {
  settingsPath: string;
  scriptPath: string;
  events: string[];
  settingsExisted: boolean;
  alreadyInstalled: boolean;
  existingUserHookEvents: string[];
}

export interface ClaudeHookInstallResult extends ClaudeHookInstallPlan {
  changed: boolean;
  backupPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readSettings(settingsPath: string): Promise<{ doc: Record<string, unknown>; existed: boolean }> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { doc: parsed, existed: true } : { doc: {}, existed: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { doc: {}, existed: false };
    throw new Error(`Claude Code settings at ${settingsPath} are not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hookCommand(scriptPath: string): string {
  return `if [ -f '${scriptPath}' ]; then /bin/sh '${scriptPath}'; else printf '{}\\n'; fi`;
}

function buildManagedHookEntries(scriptPath: string): Array<{ event: string; matcher?: string }> {
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
function removeManagedCommands(doc: Record<string, unknown>, scriptPath: string): boolean {
  const hooks = doc.hooks;
  if (!isRecord(hooks)) return false;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups = groups.filter((group) => {
      if (!isRecord(group)) return true;
      const entries = group.hooks;
      if (!Array.isArray(entries)) return true;
      const kept = entries.filter((entry) => !(isRecord(entry) && typeof entry.command === 'string' && isManagedClaudeHookCommand(entry.command)));
      if (kept.length === entries.length) return true;
      changed = true;
      if (kept.length === 0) return false;
      group.hooks = kept;
      return true;
    });
    if (keptGroups.length !== groups.length) {
      changed = true;
      if (keptGroups.length === 0) delete hooks[event];
      else hooks[event] = keptGroups;
    }
  }
  if (Object.keys(hooks).length === 0) delete doc.hooks;
  return changed;
}

function hasManagedCommands(doc: Record<string, unknown>): boolean {
  const hooks = doc.hooks;
  if (!isRecord(hooks)) return false;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) {
        if (isRecord(entry) && typeof entry.command === 'string' && isManagedClaudeHookCommand(entry.command)) return true;
      }
    }
  }
  return false;
}

async function writeSettingsAtomic(settingsPath: string, doc: Record<string, unknown>): Promise<void> {
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  const temp = `${settingsPath}.tmp-${randomUUID()}`;
  await fs.writeFile(temp, body, 'utf8');
  await fs.rename(temp, settingsPath);
}

export async function planClaudeHookInstall(input: {
  agentsDir: string;
  homeDir?: string;
}): Promise<ClaudeHookInstallPlan> {
  const settingsPath = claudeSettingsPath(input.homeDir);
  const { doc, existed } = await readSettings(settingsPath);
  return {
    settingsPath,
    scriptPath: claudeHookScriptPath(input.agentsDir),
    events: [...BARE_EVENTS, ...MATCHER_EVENTS],
    settingsExisted: existed,
    alreadyInstalled: hasManagedCommands(doc),
    existingUserHookEvents: Object.keys(isRecord(doc.hooks) ? doc.hooks : {}),
  };
}

export async function installClaudeHooks(input: {
  agentsDir: string;
  homeDir?: string;
}): Promise<ClaudeHookInstallResult> {
  const plan = await planClaudeHookInstall(input);
  await fs.mkdir(input.agentsDir, { recursive: true, mode: 0o700 });
  const scriptPath = claudeHookScriptPath(input.agentsDir);
  const tempScript = `${scriptPath}.tmp-${randomUUID()}`;
  await fs.writeFile(tempScript, renderClaudeHookScript(input.agentsDir), 'utf8');
  await fs.chmod(tempScript, 0o755);
  await fs.rename(tempScript, scriptPath);

  const { doc } = await readSettings(plan.settingsPath);
  const before = JSON.stringify(doc);
  removeManagedCommands(doc, scriptPath);
  const hooks = (isRecord(doc.hooks) ? doc.hooks : (doc.hooks = {})) as Record<string, unknown>;
  for (const { event, matcher } of buildManagedHookEntries(scriptPath)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] as Array<Record<string, unknown>> : (hooks[event] = []);
    groups.push(matcher
      ? { matcher, hooks: [{ type: 'command', command: hookCommand(scriptPath), timeout: HOOK_TIMEOUT_SECONDS }] }
      : { hooks: [{ type: 'command', command: hookCommand(scriptPath), timeout: HOOK_TIMEOUT_SECONDS }] });
  }
  const backupPath = `${plan.settingsPath}.bak`;
  if (before !== JSON.stringify(doc)) {
    try {
      await fs.copyFile(plan.settingsPath, backupPath);
    } catch {
      // First install: nothing to back up.
    }
    await fs.mkdir(path.dirname(plan.settingsPath), { recursive: true });
    await writeSettingsAtomic(plan.settingsPath, doc);
  }
  return { ...plan, changed: before !== JSON.stringify(doc), backupPath };
}

export async function uninstallClaudeHooks(input: {
  agentsDir: string;
  homeDir?: string;
}): Promise<{ settingsPath: string; changed: boolean; removedScript: boolean }> {
  const settingsPath = claudeSettingsPath(input.homeDir);
  const { doc } = await readSettings(settingsPath);
  const before = JSON.stringify(doc);
  const changed = removeManagedCommands(doc, claudeHookScriptPath(input.agentsDir));
  if (changed) {
    try {
      await fs.copyFile(settingsPath, `${settingsPath}.bak`);
    } catch {
      // Nothing to back up.
    }
    await writeSettingsAtomic(settingsPath, doc);
  }
  let removedScript = false;
  try {
    await fs.rm(claudeHookScriptPath(input.agentsDir), { force: true });
    removedScript = true;
  } catch {
    // Best effort.
  }
  return { settingsPath, changed, removedScript };
}
