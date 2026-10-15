"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.opencodeBackendFactory = void 0;
exports.createOpenCodeBackend = createOpenCodeBackend;
const acp_1 = require("./acp");
const jsonProcess_1 = require("./jsonProcess");
// OpenCode serves ACP through `opencode acp` (in-process on 1.x, via a private
// `opencode serve --stdio` child on 2.x). It has no bypass flag: full access
// comes from the shared backend's auto-approved permission answers.
const OPENCODE_ACP_DIALECT = {
    // OpenCode reports the tool id in `title` ("bash", "read") with no `name`
    // field; the shared default resolution already covers that shape.
    normalizeToolResult: (rawOutput) => {
        if (!(0, jsonProcess_1.isRecord)(rawOutput))
            return rawOutput;
        const output = typeof rawOutput.output === 'string' ? rawOutput.output : undefined;
        const metadata = (0, jsonProcess_1.isRecord)(rawOutput.metadata) ? rawOutput.metadata : {};
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
function createOpenCodeBackend(binaryPath, env) {
    return (0, acp_1.createAcpBackend)({
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
exports.opencodeBackendFactory = createOpenCodeBackend;
