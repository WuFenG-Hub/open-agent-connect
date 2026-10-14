/**
 * /api/agents/* routes — the local agent status pipeline. Managed hook
 * scripts (installed into third-party CLIs) POST their host's hook payloads
 * here with a per-boot token; the payloads are normalized into the four-state
 * vocabulary and folded into the in-memory status store. Reads are a JSON
 * snapshot and an SSE event stream. Loopback-only binding plus the token keep
 * arbitrary local processes from injecting status.
 */
import { commandFailed, commandSuccess } from '../../core/contracts/commandResult';
import { normalizeClaudeHookPayload } from '../../core/agents/claudeHookEvents';
import type { RouteHandler } from './types';

const MAX_HOOK_BODY_BYTES = 1024 * 1024;

function parseHookBody(contentType: string, raw: string): unknown {
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  // The managed shell hook posts form-encoded with `payload@-`.
  const params = new URLSearchParams(raw);
  const payload = params.get('payload');
  if (payload === null) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export const handleAgentsRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;
  const agents = handlers.agents;

  // POST /api/agents/hooks/claude-code — fire-and-forget ingest from hooks.
  if (url.pathname === '/api/agents/hooks/claude-code' && req.method === 'POST') {
    if (!agents) {
      context.sendJson(503, commandFailed('agents_disabled', 'Agent status pipeline is not configured.'));
      return true;
    }
    const token = req.headers['x-metabot-agent-hook-token'];
    if (typeof token !== 'string' || token !== agents.token) {
      context.sendJson(403, commandFailed('agent_hook_forbidden', 'Invalid agent hook token.'));
      return true;
    }
    const raw = await context.readRawBody(MAX_HOOK_BODY_BYTES);
    const payload = parseHookBody(String(req.headers['content-type'] ?? ''), raw.toString('utf8'));
    const event = normalizeClaudeHookPayload(payload);
    if (event) agents.store.ingest(event);
    context.sendJson(200, commandSuccess({ accepted: Boolean(event) }));
    return true;
  }

  // GET /api/agents/status — current snapshot rows.
  if (url.pathname === '/api/agents/status' && req.method === 'GET') {
    if (!agents) {
      context.sendJson(200, commandSuccess({ agents: [] }));
      return true;
    }
    context.sendJson(200, commandSuccess({ agents: agents.store.snapshot() }));
    return true;
  }

  // GET /api/agents/status/events — SSE stream of status transitions.
  if (url.pathname === '/api/agents/status/events' && req.method === 'GET') {
    if (!agents) {
      context.sendJson(503, commandFailed('agents_disabled', 'Agent status pipeline is not configured.'));
      return true;
    }
    const { res } = context;
    let closed = false;
    context.req.on('close', () => {
      closed = true;
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const unsubscribe = agents.store.subscribe((event, record) => {
      if (!closed) res.write(`data: ${JSON.stringify({ event, record })}\n\n`);
    });
    const keepAlive = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
      else unsubscribe();
    }, 15_000);
    context.req.on('close', () => {
      clearInterval(keepAlive);
    });
    return true;
  }

  return false;
};
