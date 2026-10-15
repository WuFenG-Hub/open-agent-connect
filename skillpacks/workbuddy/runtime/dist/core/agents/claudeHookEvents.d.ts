/**
 * Claude Code hook payload normalization. Claude Code posts one JSON object
 * per hook event on the hook command's stdin (`session_id`, `transcript_path`,
 * `cwd`, `hook_event_name`, and event-specific fields). Mapping onto the
 * four-state vocabulary follows the semantics verified by long-lived
 * orchestrators: tool use and prompt submits are working; permission requests
 * and AskUserQuestion prompts wait for a human; Stop ends the turn; a
 * SessionStart boundary reads as idle-done, never as a completion.
 */
import type { AgentStatusEvent } from './agentStatusTypes';
export declare function normalizeClaudeHookPayload(payload: unknown, now?: () => number): AgentStatusEvent | null;
