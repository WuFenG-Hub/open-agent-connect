"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLAUDE_HOOK_SPOOL_MAX_BYTES = exports.CLAUDE_HOOK_SCRIPT_NAME = void 0;
exports.claudeHookScriptPath = claudeHookScriptPath;
exports.isManagedClaudeHookCommand = isManagedClaudeHookCommand;
exports.renderClaudeHookScript = renderClaudeHookScript;
/**
 * The Claude Code hook script body. One self-contained POSIX sh program that
 * managed Claude Code settings entries invoke for every hook event:
 * prints a neutral `{}` first (Claude permission hooks fail closed on empty
 * stdout), captures the stdin JSON payload, re-discovers the daemon by
 * sourcing the endpoint file, POSTs the payload, and appends it to the spool
 * when the daemon is unreachable so a later boot can replay it.
 */
const node_path_1 = __importDefault(require("node:path"));
const agentHookEndpoint_1 = require("./agentHookEndpoint");
exports.CLAUDE_HOOK_SCRIPT_NAME = 'metabot-claude-hook.sh';
exports.CLAUDE_HOOK_SPOOL_MAX_BYTES = 5 * 1024 * 1024;
function claudeHookScriptPath(agentsDir) {
    return node_path_1.default.join(agentsDir, exports.CLAUDE_HOOK_SCRIPT_NAME);
}
/** Ownership marker: managed settings entries always reference this file. */
function isManagedClaudeHookCommand(command) {
    return command.includes(exports.CLAUDE_HOOK_SCRIPT_NAME);
}
function renderClaudeHookScript(agentsDir) {
    const endpointFile = node_path_1.default.join(agentsDir, 'hook-endpoint.env');
    const spool = (0, agentHookEndpoint_1.spoolDirPath)(agentsDir);
    const lines = [
        '#!/bin/sh',
        '# Managed by Open Agent Connect (metabot agents hooks install). Do not edit;',
        '# reinstall with: metabot agents hooks uninstall --host claude-code && metabot agents hooks install --host claude-code --confirm',
        // Claude Code permission hooks treat empty stdout as failure — answer
        // neutral JSON immediately, before anything can fail.
        "printf '{}\\n'",
        'payload=$(cat 2>/dev/null || true)',
        '[ -z "$payload" ] && exit 0',
        `if [ ! -r '${endpointFile}' ]; then exit 0; fi`,
        `. '${endpointFile}'`,
        '[ -z "$METABOT_AGENT_HOOK_PORT" ] && exit 0',
        '[ -z "$METABOT_AGENT_HOOK_TOKEN" ] && exit 0',
        'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:$METABOT_AGENT_HOOK_PORT/api/agents/hooks/claude-code" \\',
        '  --connect-timeout 0.5 --max-time 1.5 --noproxy "127.0.0.1" \\',
        '  -H "Content-Type: application/x-www-form-urlencoded" \\',
        '  -H "X-Metabot-Agent-Hook-Token: $METABOT_AGENT_HOOK_TOKEN" \\',
        '  --data-urlencode "payload@-" >/dev/null 2>&1 && exit 0',
        // Daemon unreachable: spool for replay by the next daemon boot. The
        // payload is a compact JSON object; stripping raw newlines is safe (JSON
        // only allows them as whitespace between tokens) and keeps the JSONL
        // record on one line.
        `mkdir -p '${spool}' 2>/dev/null || exit 0`,
        `chmod 700 '${spool}' 2>/dev/null`,
        `spool_file='${spool}/claude-code.jsonl'`,
        `[ -f "$spool_file" ] && [ "$(wc -c <"$spool_file" 2>/dev/null || echo 0)" -gt ${String(exports.CLAUDE_HOOK_SPOOL_MAX_BYTES)} ] && : >"$spool_file"`,
        `payload_oneline=$(printf '%s' "$payload" | tr -d '\\n\\r')`,
        `printf '{"source":"claude-code","receivedAt":%s,"payload":%s}\\n' "$(date +%s000)" "$payload_oneline" >>"$spool_file" 2>/dev/null`,
        'exit 0',
        '',
    ];
    return lines.join('\n');
}
