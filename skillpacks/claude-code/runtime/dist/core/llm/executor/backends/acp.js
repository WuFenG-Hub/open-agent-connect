"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAcpBackend = createAcpBackend;
const node_child_process_1 = require("node:child_process");
const backend_1 = require("./backend");
const acp_ndjson_framer_1 = require("./acp-ndjson-framer");
const acp_rpc_prefix_1 = require("./acp-rpc-prefix");
const acp_write_queue_1 = require("./acp-write-queue");
const jsonProcess_1 = require("./jsonProcess");
const DEFAULT_ACP_TIMEOUT_MS = 1_200_000;
const ACP_USAGE_KEY_FALLBACK = 'unknown';
const ACP_DEBUG_LOG_LINE_MAX = 2000;
function combineArgs(options, request) {
    return [
        ...options.baseArgs,
        ...(0, backend_1.filterBlockedArgs)(request.extraArgs, options.blockedArgs),
    ];
}
function getRpcErrorMessage(error, fallback) {
    if (!(0, jsonProcess_1.isRecord)(error))
        return (0, jsonProcess_1.stringifyContent)(error) || fallback;
    const data = (0, jsonProcess_1.isRecord)(error.data) ? error.data : {};
    return String(data.message ?? error.message ?? error.name ?? fallback);
}
function extractSessionId(value) {
    if (!(0, jsonProcess_1.isRecord)(value))
        return undefined;
    return (0, jsonProcess_1.getString)(value.sessionId) ?? (0, jsonProcess_1.getString)(value.session_id);
}
function buildUserText(request) {
    if (!request.systemPrompt)
        return request.prompt;
    return `${request.systemPrompt}\n\n---\n\n${request.prompt}`;
}
function updateUsage(target, value, mode) {
    if (!value)
        return;
    if (mode === 'snapshot') {
        if (value.inputTokens > target.inputTokens)
            target.inputTokens = value.inputTokens;
        if (value.outputTokens > target.outputTokens)
            target.outputTokens = value.outputTokens;
        if ((value.cacheReadTokens ?? 0) > (target.cacheReadTokens ?? 0))
            target.cacheReadTokens = value.cacheReadTokens;
        if ((value.cacheWriteTokens ?? 0) > (target.cacheWriteTokens ?? 0))
            target.cacheWriteTokens = value.cacheWriteTokens;
        return;
    }
    target.inputTokens += value.inputTokens;
    target.outputTokens += value.outputTokens;
    if (value.cacheReadTokens)
        target.cacheReadTokens = (target.cacheReadTokens ?? 0) + value.cacheReadTokens;
    if (value.cacheWriteTokens)
        target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + value.cacheWriteTokens;
}
function normalizeAcpUpdateType(value) {
    const key = value.trim().toLowerCase().replaceAll('_', '').replaceAll('-', '');
    switch (key) {
        case 'agentmessagechunk':
            return 'agent_message_chunk';
        case 'agentthoughtchunk':
            return 'agent_thought_chunk';
        case 'toolcall':
            return 'tool_call';
        case 'toolcallupdate':
            return 'tool_call_update';
        case 'usageupdate':
            return 'usage_update';
        case 'turnend':
        case 'endturn':
            return 'turn_end';
        default:
            return '';
    }
}
function normalizeAcpUpdate(value) {
    if (!(0, jsonProcess_1.isRecord)(value))
        return { type: '', data: value };
    const updateType = (0, jsonProcess_1.getString)(value.sessionUpdate) ?? (0, jsonProcess_1.getString)(value.type);
    if (updateType)
        return { type: normalizeAcpUpdateType(updateType), data: value };
    const entries = Object.entries(value);
    if (entries.length === 1) {
        const [key, data] = entries[0];
        return { type: normalizeAcpUpdateType(key), data };
    }
    return { type: '', data: value };
}
function textFromContent(value) {
    if (!(0, jsonProcess_1.isRecord)(value))
        return '';
    const content = (0, jsonProcess_1.isRecord)(value.content) ? value.content : {};
    return String(content.text ?? value.text ?? '');
}
function extractToolCallText(blocks) {
    if (!Array.isArray(blocks))
        return '';
    const pieces = [];
    for (const block of blocks) {
        if (!(0, jsonProcess_1.isRecord)(block))
            continue;
        if (block.type === 'content') {
            const content = (0, jsonProcess_1.isRecord)(block.content) ? block.content : {};
            const text = (0, jsonProcess_1.getString)(content.text);
            if (text)
                pieces.push(text);
        }
        else if (block.type === 'diff') {
            const path = (0, jsonProcess_1.getString)(block.path);
            if (path)
                pieces.push(`--- ${path}\n+++ ${path}`);
        }
    }
    return pieces.join('\n');
}
function parseToolArgs(argsText) {
    const trimmed = argsText?.trim();
    if (!trimmed)
        return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        return (0, jsonProcess_1.isRecord)(parsed) ? parsed : { text: trimmed };
    }
    catch {
        return { text: trimmed };
    }
}
function resolveAcpToolName(dialect, title, kind, name) {
    return dialect?.toolNameFromCall?.({ title, kind, name }) || name || title || kind || 'tool';
}
function defaultProviderError(stderr) {
    const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const interesting = lines.filter((line) => (/HTTP\s+\d{3}/i.test(line)
        || /API call failed/i.test(line)
        || /BadRequestError|AuthenticationError|RateLimitError/i.test(line)
        || /^Error:/i.test(line)));
    return interesting.join('\n') || undefined;
}
function createAcpBackend(options) {
    return {
        provider: options.provider,
        async execute(request, emitter, signal) {
            const startedAt = Date.now();
            const args = combineArgs(options, request);
            const child = (0, node_child_process_1.spawn)(options.binaryPath, args, {
                cwd: request.cwd,
                env: (0, backend_1.buildProcessEnv)(options.env, { ...(request.env ?? {}), ...(options.forcedEnv ?? {}) }),
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let nextId = 1;
            const pending = new Map();
            const pendingTools = new Map();
            const outputParts = [];
            const usage = { inputTokens: 0, outputTokens: 0 };
            let sessionId = request.resumeSessionId;
            let finalStatus = 'completed';
            let finalError;
            let stderr = '';
            let promptStarted = false;
            let sawTurnEndUsage = false;
            const childExit = new Promise((resolve) => {
                child.on('close', (code) => resolve(code));
            });
            const childError = new Promise((resolve) => {
                child.once('error', (error) => resolve(error));
            });
            const maxLineBytes = options.maxLineBytes ?? acp_ndjson_framer_1.ACP_NDJSON_MAX_LINE_BYTES;
            const writeQueue = new acp_write_queue_1.AcpWriteQueue(child.stdin);
            let transportFailed;
            const failTransport = (reason) => {
                if (transportFailed)
                    return;
                transportFailed = reason;
                writeQueue.close(new Error(reason));
                for (const pendingRequest of pending.values()) {
                    pendingRequest.reject(new Error(reason));
                }
                pending.clear();
                try {
                    child.kill('SIGTERM');
                }
                catch {
                    // Best effort.
                }
            };
            // An EPIPE on stdin means the agent is gone; without this listener the
            // stream error would escape as an unhandled error and crash the host.
            child.stdin.on('error', (error) => {
                failTransport(`${options.provider} agent stdin failed: ${(0, backend_1.stringifyError)(error)}`);
            });
            const sendRecord = (record) => {
                const line = `${JSON.stringify(record)}\n`;
                if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
                    return Promise.reject(new Error(`${options.provider} outgoing frame exceeded ${maxLineBytes} bytes`));
                }
                return writeQueue.write(line);
            };
            const requestRpc = (method, params) => {
                const id = nextId;
                nextId += 1;
                return new Promise((resolve, reject) => {
                    pending.set(id, { method, resolve, reject });
                    sendRecord({ jsonrpc: '2.0', id, method, params }).catch((error) => {
                        if (!pending.has(id))
                            return;
                        pending.delete(id);
                        reject(error instanceof Error ? error : new Error((0, backend_1.stringifyError)(error)));
                    });
                });
            };
            const handleAgentRequest = (message) => {
                if (message.id === undefined)
                    return;
                if (message.method === 'session/request_permission') {
                    // Unattended bot turns approve tool use; prefer an offered
                    // allow-always option so the answer stays valid in the agent's own
                    // vocabulary, and fall back to the historical fixed option id for
                    // agents that offer no options to pick from.
                    const params = (0, jsonProcess_1.isRecord)(message.params) ? message.params : {};
                    const offered = (Array.isArray(params.options) ? params.options : []);
                    const allowOption = offered.find((option) => (0, jsonProcess_1.isRecord)(option) && option.kind === 'allow_always')
                        ?? offered.find((option) => (0, jsonProcess_1.isRecord)(option) && option.kind === 'allow_once');
                    const optionId = allowOption && (0, jsonProcess_1.isRecord)(allowOption) && typeof allowOption.optionId === 'string'
                        ? allowOption.optionId
                        : 'approve_for_session';
                    void sendRecord({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            outcome: {
                                outcome: 'selected',
                                optionId,
                            },
                        },
                    }).catch(() => { });
                    return;
                }
                void sendRecord({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32601, message: `method not found: ${message.method ?? 'unknown'}` },
                }).catch(() => { });
            };
            const emitToolUse = (callId, tool, input) => {
                emitter.emit({ type: 'tool_use', tool, callId, input: input ?? {} });
            };
            const emitDeferredToolUse = (pendingTool, callId, title, kind, name, fallbackInput) => {
                if (pendingTool?.emitted)
                    return;
                const toolName = pendingTool?.toolName ?? resolveAcpToolName(options.dialect, title, kind, name);
                const input = pendingTool?.input ?? parseToolArgs(pendingTool?.argsText) ?? fallbackInput;
                emitToolUse(callId, toolName, input);
            };
            const handleToolCall = (data) => {
                if (!(0, jsonProcess_1.isRecord)(data))
                    return;
                const callId = String(data.toolCallId ?? data.tool_call_id ?? data.id ?? 'tool');
                const title = (0, jsonProcess_1.getString)(data.title) ?? (0, jsonProcess_1.getString)(data.name) ?? '';
                const kind = (0, jsonProcess_1.getString)(data.kind) ?? '';
                const name = (0, jsonProcess_1.getString)(data.name) ?? '';
                const toolName = resolveAcpToolName(options.dialect, title, kind, name);
                const rawInput = (0, jsonProcess_1.isRecord)(data.rawInput)
                    ? data.rawInput
                    : (0, jsonProcess_1.isRecord)(data.input)
                        ? data.input
                        : (0, jsonProcess_1.isRecord)(data.parameters)
                            ? data.parameters
                            : undefined;
                if (rawInput) {
                    pendingTools.set(callId, { toolName, input: rawInput, emitted: true });
                    emitToolUse(callId, toolName, rawInput);
                    return;
                }
                pendingTools.set(callId, {
                    toolName,
                    argsText: extractToolCallText(data.content),
                    emitted: false,
                });
            };
            const handleToolCallUpdate = (data) => {
                if (!(0, jsonProcess_1.isRecord)(data))
                    return;
                const callId = String(data.toolCallId ?? data.tool_call_id ?? data.id ?? 'tool');
                const status = (0, jsonProcess_1.getString)(data.status) ?? '';
                const pendingTool = pendingTools.get(callId);
                if (status !== 'completed' && status !== 'failed') {
                    if (pendingTool && !pendingTool.emitted) {
                        const text = extractToolCallText(data.content);
                        if (text)
                            pendingTool.argsText = text;
                    }
                    return;
                }
                pendingTools.delete(callId);
                const title = (0, jsonProcess_1.getString)(data.title) ?? (0, jsonProcess_1.getString)(data.name) ?? '';
                const kind = (0, jsonProcess_1.getString)(data.kind) ?? '';
                const name = (0, jsonProcess_1.getString)(data.name) ?? '';
                const rawInput = (0, jsonProcess_1.isRecord)(data.rawInput)
                    ? data.rawInput
                    : (0, jsonProcess_1.isRecord)(data.input)
                        ? data.input
                        : (0, jsonProcess_1.isRecord)(data.parameters)
                            ? data.parameters
                            : undefined;
                emitDeferredToolUse(pendingTool, callId, title, kind, name, rawInput);
                const rawOutput = options.dialect?.normalizeToolResult?.(data.rawOutput) ?? data.rawOutput;
                const output = (0, jsonProcess_1.stringifyContent)(rawOutput ?? data.output ?? data.result) || extractToolCallText(data.content);
                emitter.emit({ type: 'tool_result', callId, output });
            };
            const handleNotification = (message) => {
                const method = message.method ?? '';
                if (method !== 'session/update' && method !== 'session/notification')
                    return;
                if (!(0, jsonProcess_1.isRecord)(message.params))
                    return;
                const update = normalizeAcpUpdate(message.params.update);
                if (options.gateNotificationsUntilPrompt && !promptStarted)
                    return;
                if (!update.type) {
                    // Vendor extensions and newer protocol kinds must not crash the
                    // turn; log them so they stay observable instead of vanishing.
                    const rawUpdate = message.params.update;
                    const rawKind = (0, jsonProcess_1.isRecord)(rawUpdate)
                        ? (0, jsonProcess_1.getString)(rawUpdate.sessionUpdate) ?? (0, jsonProcess_1.getString)(rawUpdate.type) ?? Object.keys(rawUpdate)[0] ?? ''
                        : '';
                    emitter.emit({ type: 'log', level: 'debug', message: `${options.provider} ignored session update kind: ${rawKind}` });
                    return;
                }
                if (update.type === 'agent_message_chunk') {
                    const text = textFromContent(update.data);
                    if (text) {
                        outputParts.push(text);
                        emitter.emit({ type: 'text', content: text });
                    }
                    return;
                }
                if (update.type === 'agent_thought_chunk') {
                    const text = textFromContent(update.data);
                    if (text)
                        emitter.emit({ type: 'thinking', content: text });
                    return;
                }
                if (update.type === 'tool_call') {
                    handleToolCall(update.data);
                    return;
                }
                if (update.type === 'tool_call_update') {
                    handleToolCallUpdate(update.data);
                    return;
                }
                if (update.type === 'usage_update' && (0, jsonProcess_1.isRecord)(update.data)) {
                    updateUsage(usage, (0, jsonProcess_1.extractUsage)(update.data.usage), 'snapshot');
                    return;
                }
                if (update.type === 'turn_end' && (0, jsonProcess_1.isRecord)(update.data)) {
                    if (update.data.stopReason === 'cancelled') {
                        finalStatus = 'cancelled';
                        finalError = `${options.provider} cancelled the prompt`;
                    }
                    const turnEndUsage = (0, jsonProcess_1.extractUsage)(update.data.usage);
                    if (turnEndUsage) {
                        sawTurnEndUsage = true;
                        updateUsage(usage, turnEndUsage, 'add');
                    }
                }
            };
            child.stdout.setEncoding('utf8');
            const handleRecord = (record) => {
                const message = ((0, jsonProcess_1.isRecord)(record) ? record : {});
                if (message.id !== undefined && message.method && message.result === undefined && message.error === undefined) {
                    handleAgentRequest(message);
                    return;
                }
                if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
                    const pendingRequest = pending.get(message.id);
                    if (!pendingRequest)
                        return;
                    pending.delete(message.id);
                    if (message.error) {
                        pendingRequest.reject(new Error(getRpcErrorMessage(message.error, `${pendingRequest.method} failed`)));
                    }
                    else {
                        pendingRequest.resolve(message.result);
                    }
                    return;
                }
                if (message.method)
                    handleNotification(message);
            };
            const handleRejectedRecord = (rejected) => {
                if (rejected.kind === 'invalid-json') {
                    emitter.emit({ type: 'log', level: 'debug', message: rejected.line.slice(0, ACP_DEBUG_LOG_LINE_MAX) });
                    return;
                }
                const classified = (0, acp_rpc_prefix_1.classifyAcpRecordPrefix)(rejected.prefix);
                if (classified.kind === 'agent-request') {
                    emitter.emit({
                        type: 'log',
                        level: 'debug',
                        message: `${options.provider} dropped an oversized ${classified.method} request (${rejected.observedBytes} bytes > ${rejected.maxLineBytes})`,
                    });
                    void sendRecord({
                        jsonrpc: '2.0',
                        id: classified.id,
                        error: { code: -32600, message: `request frame exceeds ${rejected.maxLineBytes} bytes` },
                    }).catch(() => { });
                    return;
                }
                if (classified.kind === 'response') {
                    const pendingRequest = pending.get(classified.id);
                    if (pendingRequest) {
                        // The full frame is gone; settle this call now instead of letting
                        // it hang until the turn timeout.
                        pending.delete(classified.id);
                        pendingRequest.reject(new Error(`${pendingRequest.method} response frame exceeded ${rejected.maxLineBytes} bytes (${rejected.observedBytes} bytes received)`));
                    }
                    else {
                        emitter.emit({
                            type: 'log',
                            level: 'debug',
                            message: `${options.provider} dropped an oversized response for unknown request id ${classified.id}`,
                        });
                    }
                    return;
                }
                if (classified.kind === 'response-unknown') {
                    // A response we cannot bind to a pending call would leave that call
                    // hanging until the turn timeout; fail the transport instead.
                    failTransport(`${options.provider} sent an oversized response frame that could not be bound to a request (${rejected.observedBytes} bytes)`);
                    return;
                }
                emitter.emit({
                    type: 'log',
                    level: 'debug',
                    message: `${options.provider} dropped an oversized frame (${rejected.observedBytes} bytes > ${rejected.maxLineBytes})`,
                });
            };
            const framer = (0, acp_ndjson_framer_1.createBoundedNdjsonFramer)(handleRecord, handleRejectedRecord, { maxLineBytes });
            child.stdout.on('data', (chunk) => {
                framer.feed(chunk);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
                if (stderr.length > 8192)
                    stderr = stderr.slice(-8192);
            });
            const timeoutMs = request.timeout ?? DEFAULT_ACP_TIMEOUT_MS;
            let timeoutHandle;
            const timeout = new Promise((resolve) => {
                timeoutHandle = setTimeout(() => {
                    finalStatus = 'timeout';
                    finalError = `${options.provider} timed out after ${timeoutMs}ms`;
                    try {
                        child.kill('SIGTERM');
                    }
                    catch {
                        // Best effort.
                    }
                    resolve();
                }, timeoutMs);
            });
            const abort = new Promise((resolve) => {
                if (signal.aborted) {
                    finalStatus = 'cancelled';
                    finalError = `${options.provider} execution cancelled`;
                    resolve();
                    return;
                }
                signal.addEventListener('abort', () => {
                    finalStatus = 'cancelled';
                    finalError = `${options.provider} execution cancelled`;
                    try {
                        child.kill('SIGTERM');
                    }
                    catch {
                        // Best effort.
                    }
                    resolve();
                }, { once: true });
            });
            const awaitStep = async (promise, phase) => {
                const completion = await Promise.race([
                    promise.then((value) => ({ type: 'value', value })),
                    timeout.then(() => ({ type: 'terminal' })),
                    abort.then(() => ({ type: 'terminal' })),
                    childError.then((error) => ({ type: 'error', error })),
                    childExit.then(() => ({ type: 'exit' })),
                ]);
                if (completion.type === 'value')
                    return completion.value;
                if (completion.type === 'error') {
                    finalStatus = 'failed';
                    finalError = (0, backend_1.stringifyError)(completion.error);
                }
                else if (completion.type === 'exit' && finalStatus === 'completed') {
                    finalStatus = 'failed';
                    finalError = `${options.provider} process exited before ${phase}`;
                }
                throw new Error(finalError ?? `${options.provider} ${phase} did not complete`);
            };
            try {
                await awaitStep(requestRpc('initialize', {
                    protocolVersion: 1,
                    clientInfo: {
                        name: 'multica-agent-sdk',
                        version: '0.2.0',
                    },
                    clientCapabilities: {},
                }), 'initialize');
                const cwd = request.cwd || '.';
                if (request.resumeSessionId) {
                    const resumeParams = {
                        cwd,
                        sessionId: request.resumeSessionId,
                    };
                    if (options.includeMcpServersInResume)
                        resumeParams.mcpServers = [];
                    const resumed = await awaitStep(requestRpc(options.resumeMethod, resumeParams), options.resumeMethod);
                    sessionId = extractSessionId(resumed) ?? request.resumeSessionId;
                }
                else {
                    const newParams = {
                        cwd,
                        mcpServers: [],
                    };
                    if (options.includeModelInNewSession && request.model)
                        newParams.model = request.model;
                    const created = await awaitStep(requestRpc('session/new', newParams), 'session/new');
                    sessionId = extractSessionId(created);
                    if (!sessionId)
                        throw new Error(`${options.provider} session/new returned no session ID`);
                }
                if (request.model) {
                    const switchRequest = options.dialect?.setModelRequest?.(sessionId, request.model) ?? {
                        method: 'session/set_model',
                        params: { sessionId, modelId: request.model },
                    };
                    try {
                        await awaitStep(requestRpc(switchRequest.method, switchRequest.params), switchRequest.method);
                    }
                    catch (error) {
                        finalStatus = 'failed';
                        finalError = `${options.provider} could not switch to model "${request.model}": ${(0, backend_1.stringifyError)(error)}`;
                        throw error;
                    }
                }
                const promptBlocks = [{ type: 'text', text: buildUserText(request) }];
                const promptParams = {
                    sessionId,
                    prompt: promptBlocks,
                };
                if (options.sendPromptContentAlias)
                    promptParams.content = promptBlocks;
                promptStarted = true;
                const promptResult = await awaitStep(requestRpc('session/prompt', promptParams), 'session/prompt');
                if ((0, jsonProcess_1.isRecord)(promptResult)) {
                    if (promptResult.stopReason === 'cancelled') {
                        finalStatus = 'cancelled';
                        finalError = `${options.provider} cancelled the prompt`;
                    }
                    if (!sawTurnEndUsage) {
                        updateUsage(usage, (0, jsonProcess_1.extractUsage)(promptResult.usage), 'add');
                    }
                }
            }
            catch (error) {
                if (finalStatus === 'completed') {
                    finalStatus = 'failed';
                    finalError = (0, backend_1.stringifyError)(error);
                }
            }
            finally {
                if (timeoutHandle)
                    clearTimeout(timeoutHandle);
                for (const pendingRequest of pending.values()) {
                    pendingRequest.reject(new Error(`${options.provider} process closed`));
                }
                pending.clear();
                try {
                    child.stdin.end();
                }
                catch {
                    // Best effort.
                }
                writeQueue.close(new Error(`${options.provider} process closed`));
                await (0, backend_1.shutdownChildProcess)(child, childExit, {
                    terminate: finalStatus !== 'completed',
                    graceMs: finalStatus === 'completed' ? 2_000 : 250,
                });
            }
            const output = outputParts.join('');
            if (finalStatus === 'completed' && !output) {
                const providerError = defaultProviderError(stderr);
                if (providerError) {
                    finalStatus = 'failed';
                    finalError = providerError;
                }
            }
            const usageKey = request.model || ACP_USAGE_KEY_FALLBACK;
            return {
                status: finalStatus,
                output,
                error: finalError,
                providerSessionId: sessionId,
                durationMs: Date.now() - startedAt,
                usage: (0, jsonProcess_1.usageRecordHasTokens)(usage) ? { [usageKey]: usage } : undefined,
            };
        },
    };
}
