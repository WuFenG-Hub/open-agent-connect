import { spawn } from 'node:child_process';
import type { LlmExecutionRequest, LlmExecutionResult, LlmEventEmitter, LlmTokenUsage } from '../types';
import { buildProcessEnv, filterBlockedArgs, shutdownChildProcess, stringifyError, type BlockedArgSpec, type LlmBackend } from './backend';
import type { AcpDialect } from './acp-dialect';
import { ACP_NDJSON_MAX_LINE_BYTES, createBoundedNdjsonFramer, type AcpRejectedRecord } from './acp-ndjson-framer';
import { classifyAcpRecordPrefix } from './acp-rpc-prefix';
import { AcpWriteQueue } from './acp-write-queue';
import type { AcpIncomingEnvelope, AcpRpcMessage } from './acp-protocol';
import { extractUsage, getString, isRecord, stringifyContent, usageRecordHasTokens } from './jsonProcess';

const DEFAULT_ACP_TIMEOUT_MS = 1_200_000;
const ACP_USAGE_KEY_FALLBACK = 'unknown';
const ACP_DEBUG_LOG_LINE_MAX = 2000;

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingToolCall {
  toolName: string;
  input?: Record<string, unknown>;
  argsText?: string;
  emitted: boolean;
}

export interface AcpBackendOptions {
  provider: string;
  binaryPath: string;
  env?: Record<string, string>;
  baseArgs: string[];
  blockedArgs: Record<string, BlockedArgSpec>;
  forcedEnv?: Record<string, string>;
  resumeMethod: 'session/resume' | 'session/load';
  includeModelInNewSession?: boolean;
  includeMcpServersInResume?: boolean;
  sendPromptContentAlias?: boolean;
  gateNotificationsUntilPrompt?: boolean;
  /** Per-provider deviations; see acp-dialect.ts. */
  dialect?: AcpDialect;
  /** Inbound ndjson line cap; oversized lines are classified and rejected. */
  maxLineBytes?: number;
}

function combineArgs(options: AcpBackendOptions, request: LlmExecutionRequest): string[] {
  return [
    ...options.baseArgs,
    ...filterBlockedArgs(request.extraArgs, options.blockedArgs),
  ];
}

function getRpcErrorMessage(error: unknown, fallback: string): string {
  if (!isRecord(error)) return stringifyContent(error) || fallback;
  const data = isRecord(error.data) ? error.data : {};
  return String(data.message ?? error.message ?? error.name ?? fallback);
}

function extractSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return getString(value.sessionId) ?? getString(value.session_id);
}

function buildUserText(request: LlmExecutionRequest): string {
  if (!request.systemPrompt) return request.prompt;
  return `${request.systemPrompt}\n\n---\n\n${request.prompt}`;
}

function updateUsage(target: LlmTokenUsage, value: LlmTokenUsage | undefined, mode: 'snapshot' | 'add'): void {
  if (!value) return;
  if (mode === 'snapshot') {
    if (value.inputTokens > target.inputTokens) target.inputTokens = value.inputTokens;
    if (value.outputTokens > target.outputTokens) target.outputTokens = value.outputTokens;
    if ((value.cacheReadTokens ?? 0) > (target.cacheReadTokens ?? 0)) target.cacheReadTokens = value.cacheReadTokens;
    if ((value.cacheWriteTokens ?? 0) > (target.cacheWriteTokens ?? 0)) target.cacheWriteTokens = value.cacheWriteTokens;
    return;
  }
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  if (value.cacheReadTokens) target.cacheReadTokens = (target.cacheReadTokens ?? 0) + value.cacheReadTokens;
  if (value.cacheWriteTokens) target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + value.cacheWriteTokens;
}

function normalizeAcpUpdateType(value: string): string {
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

function normalizeAcpUpdate(value: unknown): { type: string; data: unknown } {
  if (!isRecord(value)) return { type: '', data: value };
  const updateType = getString(value.sessionUpdate) ?? getString(value.type);
  if (updateType) return { type: normalizeAcpUpdateType(updateType), data: value };
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const [key, data] = entries[0];
    return { type: normalizeAcpUpdateType(key), data };
  }
  return { type: '', data: value };
}

function textFromContent(value: unknown): string {
  if (!isRecord(value)) return '';
  const content = isRecord(value.content) ? value.content : {};
  return String(content.text ?? value.text ?? '');
}

function extractToolCallText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const pieces: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'content') {
      const content = isRecord(block.content) ? block.content : {};
      const text = getString(content.text);
      if (text) pieces.push(text);
    } else if (block.type === 'diff') {
      const path = getString(block.path);
      if (path) pieces.push(`--- ${path}\n+++ ${path}`);
    }
  }
  return pieces.join('\n');
}

function parseToolArgs(argsText: string | undefined): Record<string, unknown> | undefined {
  const trimmed = argsText?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : { text: trimmed };
  } catch {
    return { text: trimmed };
  }
}

function resolveAcpToolName(dialect: AcpDialect | undefined, title: string, kind: string, name: string): string {
  return dialect?.toolNameFromCall?.({ title, kind, name }) || name || title || kind || 'tool';
}

function defaultProviderError(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const interesting = lines.filter((line) => (
    /HTTP\s+\d{3}/i.test(line)
    || /API call failed/i.test(line)
    || /BadRequestError|AuthenticationError|RateLimitError/i.test(line)
    || /^Error:/i.test(line)
  ));
  return interesting.join('\n') || undefined;
}

export function createAcpBackend(options: AcpBackendOptions): LlmBackend {
  return {
    provider: options.provider,
    async execute(request: LlmExecutionRequest, emitter: LlmEventEmitter, signal: AbortSignal): Promise<LlmExecutionResult> {
      const startedAt = Date.now();
      const args = combineArgs(options, request);
      const child = spawn(options.binaryPath, args, {
        cwd: request.cwd,
        env: buildProcessEnv(options.env, { ...(request.env ?? {}), ...(options.forcedEnv ?? {}) }),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let nextId = 1;
      const pending = new Map<number | string, PendingRpc>();
      const pendingTools = new Map<string, PendingToolCall>();
      const outputParts: string[] = [];
      const usage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
      let sessionId: string | undefined = request.resumeSessionId;
      let finalStatus: LlmExecutionResult['status'] = 'completed';
      let finalError: string | undefined;
      let stderr = '';
      let promptStarted = false;
      let sawTurnEndUsage = false;

      const childExit = new Promise<number | null>((resolve) => {
        child.on('close', (code) => resolve(code));
      });
      const childError = new Promise<Error>((resolve) => {
        child.once('error', (error) => resolve(error));
      });

      const maxLineBytes = options.maxLineBytes ?? ACP_NDJSON_MAX_LINE_BYTES;
      const writeQueue = new AcpWriteQueue(child.stdin);

      let transportFailed: string | undefined;
      const failTransport = (reason: string): void => {
        if (transportFailed) return;
        transportFailed = reason;
        writeQueue.close(new Error(reason));
        for (const pendingRequest of pending.values()) {
          pendingRequest.reject(new Error(reason));
        }
        pending.clear();
        try {
          child.kill('SIGTERM');
        } catch {
          // Best effort.
        }
      };

      // An EPIPE on stdin means the agent is gone; without this listener the
      // stream error would escape as an unhandled error and crash the host.
      child.stdin.on('error', (error: Error) => {
        failTransport(`${options.provider} agent stdin failed: ${stringifyError(error)}`);
      });

      const sendRecord = (record: AcpRpcMessage): Promise<void> => {
        const line = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          return Promise.reject(new Error(`${options.provider} outgoing frame exceeded ${maxLineBytes} bytes`));
        }
        return writeQueue.write(line);
      };

      const requestRpc = (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const id = nextId;
        nextId += 1;
        return new Promise((resolve, reject) => {
          pending.set(id, { method, resolve, reject });
          sendRecord({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(stringifyError(error)));
          });
        });
      };

      const handleAgentRequest = (message: AcpIncomingEnvelope) => {
        if (message.id === undefined) return;
        if (message.method === 'session/request_permission') {
          // Unattended bot turns approve tool use; prefer an offered
          // allow-always option so the answer stays valid in the agent's own
          // vocabulary, and fall back to the historical fixed option id for
          // agents that offer no options to pick from.
          const params = isRecord(message.params) ? message.params : {};
          const offered = (Array.isArray(params.options) ? params.options : []) as unknown[];
          const allowOption = offered.find((option: unknown) => isRecord(option) && option.kind === 'allow_always')
            ?? offered.find((option: unknown) => isRecord(option) && option.kind === 'allow_once');
          const optionId = allowOption && isRecord(allowOption) && typeof allowOption.optionId === 'string'
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
          }).catch(() => {});
          return;
        }
        void sendRecord({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method ?? 'unknown'}` },
        }).catch(() => {});
      };

      const emitToolUse = (callId: string, tool: string, input: Record<string, unknown> | undefined) => {
        emitter.emit({ type: 'tool_use', tool, callId, input: input ?? {} });
      };

      const emitDeferredToolUse = (
        pendingTool: PendingToolCall | undefined,
        callId: string,
        title: string,
        kind: string,
        name: string,
        fallbackInput: Record<string, unknown> | undefined,
      ) => {
        if (pendingTool?.emitted) return;
        const toolName = pendingTool?.toolName ?? resolveAcpToolName(options.dialect, title, kind, name);
        const input = pendingTool?.input ?? parseToolArgs(pendingTool?.argsText) ?? fallbackInput;
        emitToolUse(callId, toolName, input);
      };

      const handleToolCall = (data: unknown) => {
        if (!isRecord(data)) return;
        const callId = String(data.toolCallId ?? data.tool_call_id ?? data.id ?? 'tool');
        const title = getString(data.title) ?? getString(data.name) ?? '';
        const kind = getString(data.kind) ?? '';
        const name = getString(data.name) ?? '';
        const toolName = resolveAcpToolName(options.dialect, title, kind, name);
        const rawInput = isRecord(data.rawInput)
          ? data.rawInput
          : isRecord(data.input)
            ? data.input
            : isRecord(data.parameters)
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

      const handleToolCallUpdate = (data: unknown) => {
        if (!isRecord(data)) return;
        const callId = String(data.toolCallId ?? data.tool_call_id ?? data.id ?? 'tool');
        const status = getString(data.status) ?? '';
        const pendingTool = pendingTools.get(callId);
        if (status !== 'completed' && status !== 'failed') {
          if (pendingTool && !pendingTool.emitted) {
            const text = extractToolCallText(data.content);
            if (text) pendingTool.argsText = text;
          }
          return;
        }
        pendingTools.delete(callId);
        const title = getString(data.title) ?? getString(data.name) ?? '';
        const kind = getString(data.kind) ?? '';
        const name = getString(data.name) ?? '';
        const rawInput = isRecord(data.rawInput)
          ? data.rawInput
          : isRecord(data.input)
            ? data.input
            : isRecord(data.parameters)
              ? data.parameters
              : undefined;
        emitDeferredToolUse(pendingTool, callId, title, kind, name, rawInput);
        const rawOutput = options.dialect?.normalizeToolResult?.(data.rawOutput) ?? data.rawOutput;
        const output = stringifyContent(rawOutput ?? data.output ?? data.result) || extractToolCallText(data.content);
        emitter.emit({ type: 'tool_result', callId, output });
      };

      const handleNotification = (message: AcpIncomingEnvelope) => {
        const method = message.method ?? '';
        if (method !== 'session/update' && method !== 'session/notification') return;
        if (!isRecord(message.params)) return;
        const update = normalizeAcpUpdate(message.params.update);
        if (options.gateNotificationsUntilPrompt && !promptStarted) return;
        if (!update.type) {
          // Vendor extensions and newer protocol kinds must not crash the
          // turn; log them so they stay observable instead of vanishing.
          const rawUpdate = message.params.update;
          const rawKind = isRecord(rawUpdate)
            ? getString(rawUpdate.sessionUpdate) ?? getString(rawUpdate.type) ?? Object.keys(rawUpdate)[0] ?? ''
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
          if (text) emitter.emit({ type: 'thinking', content: text });
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
        if (update.type === 'usage_update' && isRecord(update.data)) {
          updateUsage(usage, extractUsage(update.data.usage), 'snapshot');
          return;
        }
        if (update.type === 'turn_end' && isRecord(update.data)) {
          if (update.data.stopReason === 'cancelled') {
            finalStatus = 'cancelled';
            finalError = `${options.provider} cancelled the prompt`;
          }
          const turnEndUsage = extractUsage(update.data.usage);
          if (turnEndUsage) {
            sawTurnEndUsage = true;
            updateUsage(usage, turnEndUsage, 'add');
          }
        }
      };

      child.stdout.setEncoding('utf8');
      const handleRecord = (record: unknown) => {
        const message = (isRecord(record) ? record : {}) as AcpIncomingEnvelope;

        if (message.id !== undefined && message.method && message.result === undefined && message.error === undefined) {
          handleAgentRequest(message);
          return;
        }

        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
          const pendingRequest = pending.get(message.id);
          if (!pendingRequest) return;
          pending.delete(message.id);
          if (message.error) {
            pendingRequest.reject(new Error(getRpcErrorMessage(message.error, `${pendingRequest.method} failed`)));
          } else {
            pendingRequest.resolve(message.result);
          }
          return;
        }

        if (message.method) handleNotification(message);
      };

      const handleRejectedRecord = (rejected: AcpRejectedRecord): void => {
        if (rejected.kind === 'invalid-json') {
          emitter.emit({ type: 'log', level: 'debug', message: rejected.line.slice(0, ACP_DEBUG_LOG_LINE_MAX) });
          return;
        }
        const classified = classifyAcpRecordPrefix(rejected.prefix);
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
          }).catch(() => {});
          return;
        }
        if (classified.kind === 'response') {
          const pendingRequest = pending.get(classified.id);
          if (pendingRequest) {
            // The full frame is gone; settle this call now instead of letting
            // it hang until the turn timeout.
            pending.delete(classified.id);
            pendingRequest.reject(new Error(`${pendingRequest.method} response frame exceeded ${rejected.maxLineBytes} bytes (${rejected.observedBytes} bytes received)`));
          } else {
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

      const framer = createBoundedNdjsonFramer(handleRecord, handleRejectedRecord, { maxLineBytes });
      child.stdout.on('data', (chunk: string) => {
        framer.feed(chunk);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      const timeoutMs = request.timeout ?? DEFAULT_ACP_TIMEOUT_MS;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          finalStatus = 'timeout';
          finalError = `${options.provider} timed out after ${timeoutMs}ms`;
          try {
            child.kill('SIGTERM');
          } catch {
            // Best effort.
          }
          resolve();
        }, timeoutMs);
      });

      const abort = new Promise<void>((resolve) => {
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
          } catch {
            // Best effort.
          }
          resolve();
        }, { once: true });
      });

      const awaitStep = async (promise: Promise<unknown>, phase: string): Promise<unknown> => {
        const completion = await Promise.race([
          promise.then((value) => ({ type: 'value' as const, value })),
          timeout.then(() => ({ type: 'terminal' as const })),
          abort.then(() => ({ type: 'terminal' as const })),
          childError.then((error) => ({ type: 'error' as const, error })),
          childExit.then(() => ({ type: 'exit' as const })),
        ]);
        if (completion.type === 'value') return completion.value;
        if (completion.type === 'error') {
          finalStatus = 'failed';
          finalError = stringifyError(completion.error);
        } else if (completion.type === 'exit' && finalStatus === 'completed') {
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
          const resumeParams: Record<string, unknown> = {
            cwd,
            sessionId: request.resumeSessionId,
          };
          if (options.includeMcpServersInResume) resumeParams.mcpServers = [];
          const resumed = await awaitStep(requestRpc(options.resumeMethod, resumeParams), options.resumeMethod);
          sessionId = extractSessionId(resumed) ?? request.resumeSessionId;
        } else {
          const newParams: Record<string, unknown> = {
            cwd,
            mcpServers: [],
          };
          if (options.includeModelInNewSession && request.model) newParams.model = request.model;
          const created = await awaitStep(requestRpc('session/new', newParams), 'session/new');
          sessionId = extractSessionId(created);
          if (!sessionId) throw new Error(`${options.provider} session/new returned no session ID`);
        }

        if (request.model) {
          const switchRequest = options.dialect?.setModelRequest?.(sessionId, request.model) ?? {
            method: 'session/set_model',
            params: { sessionId, modelId: request.model } as Record<string, unknown>,
          };
          try {
            await awaitStep(requestRpc(switchRequest.method, switchRequest.params), switchRequest.method);
          } catch (error) {
            finalStatus = 'failed';
            finalError = `${options.provider} could not switch to model "${request.model}": ${stringifyError(error)}`;
            throw error;
          }
        }

        const promptBlocks = [{ type: 'text', text: buildUserText(request) }];
        const promptParams: Record<string, unknown> = {
          sessionId,
          prompt: promptBlocks,
        };
        if (options.sendPromptContentAlias) promptParams.content = promptBlocks;
        promptStarted = true;
        const promptResult = await awaitStep(requestRpc('session/prompt', promptParams), 'session/prompt');
        if (isRecord(promptResult)) {
          if (promptResult.stopReason === 'cancelled') {
            finalStatus = 'cancelled';
            finalError = `${options.provider} cancelled the prompt`;
          }
          if (!sawTurnEndUsage) {
            updateUsage(usage, extractUsage(promptResult.usage), 'add');
          }
        }
      } catch (error) {
        if (finalStatus === 'completed') {
          finalStatus = 'failed';
          finalError = stringifyError(error);
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        for (const pendingRequest of pending.values()) {
          pendingRequest.reject(new Error(`${options.provider} process closed`));
        }
        pending.clear();
        try {
          child.stdin.end();
        } catch {
          // Best effort.
        }
        writeQueue.close(new Error(`${options.provider} process closed`));
        await shutdownChildProcess(child, childExit, {
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
        usage: usageRecordHasTokens(usage) ? { [usageKey]: usage } : undefined,
      };
    },
  };
}
