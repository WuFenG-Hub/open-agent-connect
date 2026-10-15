"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeClaudeHookPayload = normalizeClaudeHookPayload;
const WORKING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']);
const DONE_EVENTS = new Set(['Stop', 'StopFailure', 'SubagentStopIdle']);
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}
const STATE_BY_EVENT = {
    PermissionRequest: 'waiting',
    SessionStart: 'done',
    Stop: 'done',
    StopFailure: 'done',
};
function normalizeClaudeHookPayload(payload, now = Date.now) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const record = payload;
    const sessionId = text(record.session_id) || text(record.sessionId);
    if (!sessionId)
        return null;
    const hookEventName = text(record.hook_event_name) || text(record.hookEventName) || text(record.hook_type);
    if (!hookEventName)
        return null;
    let state = STATE_BY_EVENT[hookEventName];
    let sessionBoundary = false;
    if (hookEventName === 'SessionStart') {
        const source = text(record.source);
        if (source !== 'startup' && source !== 'resume' && source !== 'clear') {
            // Unknown SessionStart sources fail closed: no status rather than a
            // wrong one.
            return null;
        }
        sessionBoundary = true;
    }
    if (!state) {
        if (DONE_EVENTS.has(hookEventName))
            state = 'done';
        else if (WORKING_EVENTS.has(hookEventName))
            state = 'working';
    }
    if (hookEventName === 'PreToolUse' && text(record.tool_name) === 'AskUserQuestion') {
        state = 'waiting';
    }
    if (!state)
        return null;
    return {
        provider: 'claude-code',
        sessionId,
        state,
        cwd: text(record.cwd),
        transcriptPath: text(record.transcript_path) || text(record.transcriptPath),
        prompt: hookEventName === 'UserPromptSubmit' ? text(record.prompt) : '',
        toolName: text(record.tool_name) || text(record.toolName),
        sessionBoundary,
        hookEventName,
        observedAt: now(),
    };
}
