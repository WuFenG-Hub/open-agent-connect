/**
 * TypeScript view of the Agent Client Protocol surface this backend consumes,
 * hand-derived from the pinned schema release schema-v1.21.0
 * (github.com/agentclientprotocol/agent-client-protocol). Enums are kept open:
 * agents extend the protocol with vendor values, and this backend must parse
 * those without dropping frames. Validation stays defensive at runtime — these
 * types document shapes, they do not enforce them.
 */
export type AcpRpcMessage = AcpRpcRequest | AcpRpcResponse | AcpRpcNotification;

/**
 * Loose envelope for discriminating an incoming frame. Inbound records are
 * never trusted to match a strict variant — agents deviate from and extend
 * the protocol — so the receive path narrows defensively from this shape.
 */
export interface AcpIncomingEnvelope {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface AcpRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface AcpRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** Session update kinds from schema-v1.21.0, plus vendor extensions. */
export type AcpSessionUpdateKind =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'plan_update'
  | 'plan_removed'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'usage_update'
  | 'compaction_update'
  | 'compaction_summary_chunk'
  | 'turn_end'
  | (string & {});

export interface AcpContentBlock {
  type?: string;
  text?: string;
  content?: { type?: string; text?: string };
  [key: string]: unknown;
}

export interface AcpToolCallUpdate {
  toolCallId?: string;
  tool_call_id?: string;
  id?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId?: string;
  name?: string;
  kind?: string;
  [key: string]: unknown;
}
