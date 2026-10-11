import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { PrivateChatInboundMessage } from '../chat/privateChatTypes';
import { resolveMetabotPaths } from '../state/paths';
import {
  grokBotBindingPathForProfile,
  readGrokBotBinding,
  recordGrokBotWebhookDelivery,
  type GrokBotBinding,
} from './grokBotBinding';

export type GrokBotWebhookDeliveryOutcome =
  | 'delivered'
  | 'not_configured'
  | 'failed'
  /** Attempt budget exhausted: the message is handed to the relay ledger so the backfill stops re-driving it. */
  | 'gave_up';

export const GROK_BOT_WEBHOOK_TIMEOUT_MS = 15_000;
/** Bounded redelivery: the backfill sweep naturally spaces retries minutes apart; after this many failed attempts the message is marked as relayed anyway (and the failure stays visible in the binding ledger). */
export const GROK_BOT_WEBHOOK_MAX_ATTEMPTS = 3;
const MAX_ERROR_BODY_CHARS = 200;
const MAX_ATTEMPT_ENTRIES = 200;

function toIsoTimestamp(timestamp: number): string {
  // Chain timestamps have appeared in both seconds and milliseconds.
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  return new Date(ms).toISOString();
}

function buildPrivateChatPayload(input: {
  homeDir: string;
  message: PrivateChatInboundMessage;
}): Record<string, unknown> {
  const slug = path.basename(resolveMetabotPaths(input.homeDir).profileRoot);
  return {
    type: 'metaweb-private-chat',
    host: 'grok-bot',
    slug,
    fromGlobalMetaId: input.message.fromGlobalMetaId,
    text: input.message.content,
    contentType: input.message.contentType ?? 'text',
    messageId: input.message.messagePinId,
    receivedAt: toIsoTimestamp(input.message.timestamp),
  };
}

async function readResponseExcerpt(response: Response): Promise<string> {
  try {
    const body = (await response.text()).replace(/\s+/g, ' ').trim();
    return body ? body.slice(0, MAX_ERROR_BODY_CHARS) : '';
  } catch {
    return '';
  }
}

export async function postGrokBotWebhook(input: {
  binding: GrokBotBinding;
  payload: Record<string, unknown>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const webhook = input.binding.webhook;
  if (!webhook) {
    return { ok: false, error: 'webhook not configured' };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (webhook.secret) {
    headers.authorization = `Bearer ${webhook.secret}`;
  }
  let response: Response;
  try {
    response = await input.fetchImpl(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(input.timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // A 2xx only means the Grok Bot routine started a turn, per the platform's
  // webhook semantics; the reply itself lands on-chain later, if the user
  // approves it. Non-2xx is a real delivery failure — keep a truncated body
  // excerpt so the failure explains itself (a bare "HTTP 400" does not).
  if (!response.ok) {
    const excerpt = await readResponseExcerpt(response);
    return { ok: false, error: `HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}` };
  }
  return { ok: true };
}

interface WebhookAttemptsState {
  attempts: Record<string, { count: number; lastAt: string; lastError: string | null }>;
}

function webhookAttemptsPathForProfile(homeDir: string): string {
  return path.join(resolveMetabotPaths(homeDir).stateRoot, 'grok-bot-webhook-attempts.json');
}

async function readWebhookAttempts(filePath: string): Promise<WebhookAttemptsState> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as WebhookAttemptsState;
    if (parsed && typeof parsed === 'object' && parsed.attempts && typeof parsed.attempts === 'object') {
      return parsed;
    }
  } catch {
    // Missing or corrupt ledger starts empty.
  }
  return { attempts: {} };
}

async function writeWebhookAttempts(filePath: string, state: WebhookAttemptsState): Promise<void> {
  // Bound the ledger: keep the most recent entries only.
  const entries = Object.entries(state.attempts)
    .sort((left, right) => right[1].lastAt.localeCompare(left[1].lastAt))
    .slice(0, MAX_ATTEMPT_ENTRIES);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ attempts: Object.fromEntries(entries) }, null, 2)}\n`, 'utf8');
}

/**
 * Deliver one inbound on-chain private-chat message to the Grok Bot assistant
 * bound to this profile, through the routine webhook recorded in the profile's
 * binding.
 *
 * Outcomes drive the caller's bookkeeping:
 * - `not_configured`: no webhook — the caller falls back to the normal local path.
 * - `delivered`: the relay owns the reply; record the message as handled.
 * - `failed`: this attempt failed; the message stays unrecorded so the next
 *   backfill sweep retries it, up to GROK_BOT_WEBHOOK_MAX_ATTEMPTS per message.
 * - `gave_up`: the budget is exhausted; record the message as handled so the
 *   sweep stops re-driving it (the failure stays on the binding ledger).
 */
export async function deliverGrokBotPrivateChat(input: {
  homeDir: string;
  message: PrivateChatInboundMessage;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}): Promise<GrokBotWebhookDeliveryOutcome> {
  const filePath = grokBotBindingPathForProfile(input.homeDir);
  const binding = await readGrokBotBinding(filePath);
  if (!binding.webhook) {
    return 'not_configured';
  }
  const now = input.now ?? (() => new Date());
  const maxAttempts = Math.max(1, input.maxAttempts ?? GROK_BOT_WEBHOOK_MAX_ATTEMPTS);
  const messageKey = input.message.messagePinId
    || `${input.message.fromGlobalMetaId}:${input.message.timestamp}`;
  const attemptsPath = webhookAttemptsPathForProfile(input.homeDir);
  const attempts = await readWebhookAttempts(attemptsPath);
  const priorAttempts = attempts.attempts[messageKey]?.count ?? 0;
  if (priorAttempts >= maxAttempts) {
    return 'gave_up';
  }

  const result = await postGrokBotWebhook({
    binding,
    payload: buildPrivateChatPayload(input),
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: input.timeoutMs ?? GROK_BOT_WEBHOOK_TIMEOUT_MS,
  });
  const at = now().toISOString();
  await recordGrokBotWebhookDelivery(filePath, {
    at,
    status: result.ok ? 'ok' : 'failed',
    kind: 'private-chat',
    error: result.ok ? null : result.error,
  });
  if (result.ok) {
    delete attempts.attempts[messageKey];
    await writeWebhookAttempts(attemptsPath, attempts).catch(() => undefined);
    return 'delivered';
  }
  attempts.attempts[messageKey] = { count: priorAttempts + 1, lastAt: at, lastError: result.error };
  await writeWebhookAttempts(attemptsPath, attempts).catch(() => undefined);
  return priorAttempts + 1 >= maxAttempts ? 'gave_up' : 'failed';
}
