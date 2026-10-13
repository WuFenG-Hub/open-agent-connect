/**
 * Per-provider deviation hooks for the shared ACP backend. Modeled after the
 * dialect layer GUI orchestrators keep beside their generic ACP lane: the
 * backend itself never branches on a provider name, so a new agent's quirks
 * land here (composed into its backend factory) instead of widening
 * AcpBackendOptions.
 */
export interface AcpToolCallDescriptor {
  title: string;
  kind: string;
  name: string;
}

export interface AcpDialect {
  /**
   * Resolve the normalized tool name for a tool call. Providers deviate:
   * Hermes/Kimi/Kiro report human titles ("terminal: pwd") that must map onto
   * a canonical snake_case vocabulary, while OpenCode reports the tool id in
   * `title` ("bash", "read") with no `name` field (the shared default
   * resolution already covers that shape).
   */
  toolNameFromCall?: (descriptor: AcpToolCallDescriptor) => string;

  /**
   * Normalize a tool_call_update rawOutput before it is stringified as the
   * tool-result output. OpenCode nests a command's output and exit code under
   * `rawOutput.metadata`; the shared shape is a plain string.
   */
  normalizeToolResult?: (rawOutput: unknown) => unknown;

  /**
   * Build the model-switch request for a session. `session/set_model` is the
   * legacy mechanism and not every agent implements it: OpenCode switches
   * models through the `model` config option instead. Returning undefined
   * fields is not allowed — omit the hook to use the legacy method.
   */
  setModelRequest?: (sessionId: string, model: string) => { method: string; params: Record<string, unknown> };
}

/**
 * Map a human tool title plus a fallback kind onto the canonical tool-name
 * vocabulary the Hermes/Kimi/Kiro ACP servers share ("terminal: pwd" ->
 * "terminal", kind "read" -> "read_file").
 */
export function acpToolNameFromTitle(title: string, kind: string): string {
  const safeTitle = title?.trim() ?? '';
  if (safeTitle === 'execute code') return 'execute_code';
  const colonIndex = safeTitle.indexOf(':');
  if (colonIndex > 0) {
    const name = safeTitle.slice(0, colonIndex).trim();
    if (name === 'terminal') return 'terminal';
    if (name === 'read') return 'read_file';
    if (name === 'write') return 'write_file';
    if (name.startsWith('patch')) return 'patch';
    if (name === 'search') return 'search_files';
    if (name === 'web search') return 'web_search';
    if (name === 'extract') return 'web_extract';
    if (name === 'delegate') return 'delegate_task';
    if (name === 'analyze image') return 'vision_analyze';
    return name;
  }
  switch (kind) {
    case 'read':
      return 'read_file';
    case 'edit':
      return 'write_file';
    case 'execute':
      return 'terminal';
    case 'search':
      return 'search_files';
    case 'fetch':
      return 'web_search';
    case 'think':
      return 'thinking';
    default:
      return safeTitle || kind || 'tool';
  }
}
