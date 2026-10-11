import type { LlmBackend, LlmBackendFactory } from './backend';
import { createAcpBackend } from './acp';
import { acpToolNameFromTitle, type AcpDialect } from './acp-dialect';

function normalizeKimiToolName(toolName: string): string {
  let value = toolName.trim();
  const colonIndex = value.indexOf(':');
  if (colonIndex > 0) value = value.slice(0, colonIndex).trim();
  const lower = value.toLowerCase();
  switch (lower) {
    case 'read':
    case 'read file':
      return 'read_file';
    case 'write':
    case 'write file':
      return 'write_file';
    case 'edit':
    case 'patch':
      return 'edit_file';
    case 'shell':
    case 'bash':
    case 'terminal':
    case 'run command':
    case 'run shell command':
      return 'terminal';
    case 'search':
    case 'grep':
    case 'find':
      return 'search_files';
    case 'glob':
      return 'glob';
    case 'web search':
      return 'web_search';
    case 'fetch':
    case 'web fetch':
      return 'web_fetch';
    case 'todo':
    case 'todo write':
      return 'todo_write';
    default:
      return lower.replaceAll(' ', '_') || 'tool';
  }
}

// Kimi reports mixed-case human tool names on top of the shared title
// vocabulary; lowercase them onto the canonical snake_case set.
const KIMI_ACP_DIALECT: AcpDialect = {
  toolNameFromCall: ({ title, kind, name }) => normalizeKimiToolName(acpToolNameFromTitle(title, kind) || name || 'tool'),
};

export function createKimiBackend(binaryPath: string, env?: Record<string, string>): LlmBackend {
  return createAcpBackend({
    provider: 'kimi',
    binaryPath,
    env,
    baseArgs: ['acp'],
    blockedArgs: {
      acp: { takesValue: false },
    },
    resumeMethod: 'session/resume',
    dialect: KIMI_ACP_DIALECT,
  });
}

export const kimiBackendFactory: LlmBackendFactory = createKimiBackend;
