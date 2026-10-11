import type { LlmExecutionRequest } from '../types';
import type { LlmBackend, LlmBackendFactory } from './backend';
import { createAcpBackend } from './acp';
import { acpToolNameFromTitle, type AcpDialect } from './acp-dialect';

// Hermes reports human tool titles ("terminal: pwd"); map them onto the
// canonical snake_case vocabulary shared with Kimi/Kiro.
const HERMES_ACP_DIALECT: AcpDialect = {
  toolNameFromCall: ({ title, kind, name }) => acpToolNameFromTitle(title, kind) || name || 'tool',
};

function buildHermesBackend(binaryPath: string, env: Record<string, string> | undefined, request: LlmExecutionRequest): LlmBackend {
  return createAcpBackend({
    provider: 'hermes',
    binaryPath,
    env,
    baseArgs: ['acp'],
    blockedArgs: {
      acp: { takesValue: false },
    },
    forcedEnv: {
      HERMES_YOLO_MODE: '1',
    },
    resumeMethod: 'session/resume',
    includeModelInNewSession: Boolean(request.model),
    gateNotificationsUntilPrompt: true,
    dialect: HERMES_ACP_DIALECT,
  });
}

export function createHermesBackend(binaryPath: string, env?: Record<string, string>): LlmBackend {
  return {
    provider: 'hermes',
    execute(request, emitter, signal) {
      return buildHermesBackend(binaryPath, env, request).execute(request, emitter, signal);
    },
  };
}

export const hermesBackendFactory: LlmBackendFactory = createHermesBackend;
