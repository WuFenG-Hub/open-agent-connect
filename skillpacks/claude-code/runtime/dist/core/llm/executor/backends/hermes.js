"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hermesBackendFactory = void 0;
exports.createHermesBackend = createHermesBackend;
const acp_1 = require("./acp");
const acp_dialect_1 = require("./acp-dialect");
// Hermes reports human tool titles ("terminal: pwd"); map them onto the
// canonical snake_case vocabulary shared with Kimi/Kiro.
const HERMES_ACP_DIALECT = {
    toolNameFromCall: ({ title, kind, name }) => (0, acp_dialect_1.acpToolNameFromTitle)(title, kind) || name || 'tool',
};
function buildHermesBackend(binaryPath, env, request) {
    return (0, acp_1.createAcpBackend)({
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
function createHermesBackend(binaryPath, env) {
    return {
        provider: 'hermes',
        execute(request, emitter, signal) {
            return buildHermesBackend(binaryPath, env, request).execute(request, emitter, signal);
        },
    };
}
exports.hermesBackendFactory = createHermesBackend;
