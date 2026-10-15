"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_STATUS_STALE_AFTER_MS = exports.AGENT_STATUS_STATES = void 0;
exports.isAgentStatusState = isAgentStatusState;
exports.AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done'];
function isAgentStatusState(value) {
    return typeof value === 'string' && exports.AGENT_STATUS_STATES.includes(value);
}
/** Sessions silent for this long are dropped from snapshots. */
exports.AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000;
