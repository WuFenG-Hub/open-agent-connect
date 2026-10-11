import type { LlmBackend, LlmBackendFactory } from './backend';
import { createAcpBackend } from './acp';
import type { AcpDialect } from './acp-dialect';
import { isRecord } from './jsonProcess';

// OpenCode serves ACP through `opencode acp` (in-process on 1.x, via a private
// `opencode serve --stdio` child on 2.x). It has no bypass flag: full access
// comes from the shared backend's auto-approved permission answers.
const OPENCODE_ACP_DIALECT: AcpDialect = {
  // OpenCode reports the tool id in `title` ("bash", "read") with no `name`
  // field; the shared default resolution already covers that shape.
  normalizeToolResult: (rawOutput) => {
    if (!isRecord(rawOutput)) return rawOutput;
    const output = typeof rawOutput.output === 'string' ? rawOutput.output : undefined;
    const metadata = isRecord(rawOutput.metadata) ? rawOutput.metadata : {};
    const metadataOutput = typeof metadata.output === 'string' ? metadata.output : undefined;
    return output ?? metadataOutput ?? rawOutput;
  },
  // OpenCode never implemented the legacy `session/set_model`; models switch
  // through the `model` config option ("provider/model", and a "/variant"
  // suffix also sets the effort).
  setModelRequest: (sessionId, model) => ({
    method: 'session/set_config_option',
    params: { sessionId, configId: 'model', value: model },
  }),
};

export function createOpenCodeBackend(binaryPath: string, env?: Record<string, string>): LlmBackend {
  return createAcpBackend({
    provider: 'opencode',
    binaryPath,
    env,
    baseArgs: ['acp'],
    blockedArgs: {
      acp: { takesValue: false },
      '--format': { takesValue: true },
      '--dir': { takesValue: true },
      '--dangerously-skip-permissions': { takesValue: false },
      '--model': { takesValue: true },
      '--prompt': { takesValue: true },
      '--session': { takesValue: true },
    },
    forcedEnv: {
      // The client name ACP sessions report, and no question tool, which an
      // unattended client could never answer.
      OPENCODE_CLIENT: 'acp',
      OPENCODE_ENABLE_QUESTION_TOOL: 'false',
    },
    resumeMethod: 'session/resume',
    dialect: OPENCODE_ACP_DIALECT,
  });
}

export const opencodeBackendFactory: LlmBackendFactory = createOpenCodeBackend;
