/**
 * Agent status pipeline types — the four-state vocabulary local agent CLIs
 * report to the daemon through managed hooks. Modeled after the status
 * vocabulary long-lived agent orchestrators converged on: `working` (a turn is
 * running), `waiting` (the agent needs a human answer), `blocked` (reserved
 * for providers that distinguish hard prompts), `done` (idle between turns).
 */
export type AgentStatusState = 'working' | 'blocked' | 'waiting' | 'done';

export const AGENT_STATUS_STATES: readonly AgentStatusState[] = ['working', 'blocked', 'waiting', 'done'];

export function isAgentStatusState(value: unknown): value is AgentStatusState {
  return typeof value === 'string' && (AGENT_STATUS_STATES as readonly string[]).includes(value);
}

/** Host that produced the event; one installer per provider. */
export type AgentHookProvider = 'claude-code';

/** Normalized hook event, provider-agnostic from here on. */
export interface AgentStatusEvent {
  provider: AgentHookProvider;
  sessionId: string;
  state: AgentStatusState;
  cwd: string;
  transcriptPath: string;
  prompt: string;
  toolName: string;
  /**
   * True when the state comes from a session boundary (session start/resume)
   * rather than a completed turn — "done" on a boundary is idle, not a
   * completion signal.
   */
  sessionBoundary: boolean;
  hookEventName: string;
  observedAt: number;
}

export interface AgentStatusRecord {
  provider: AgentHookProvider;
  sessionId: string;
  state: AgentStatusState;
  cwd: string;
  transcriptPath: string;
  prompt: string;
  toolName: string;
  sessionBoundary: boolean;
  firstObservedAt: number;
  stateStartedAt: number;
  updatedAt: number;
  lastHookEvent: string;
}

/** Sessions silent for this long are dropped from snapshots. */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000;
