"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GROK_BOT_WEBHOOK_MAX_ATTEMPTS = exports.GROK_BOT_WEBHOOK_TIMEOUT_MS = void 0;
exports.postGrokBotWebhook = postGrokBotWebhook;
exports.deliverGrokBotPrivateChat = deliverGrokBotPrivateChat;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
const paths_1 = require("../state/paths");
const grokBotBinding_1 = require("./grokBotBinding");
exports.GROK_BOT_WEBHOOK_TIMEOUT_MS = 15_000;
/** Bounded redelivery: the backfill sweep naturally spaces retries minutes apart; after this many failed attempts the message is marked as relayed anyway (and the failure stays visible in the binding ledger). */
exports.GROK_BOT_WEBHOOK_MAX_ATTEMPTS = 3;
const MAX_ERROR_BODY_CHARS = 200;
const MAX_ATTEMPT_ENTRIES = 200;
function toIsoTimestamp(timestamp) {
    // Chain timestamps have appeared in both seconds and milliseconds.
    const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
    return new Date(ms).toISOString();
}
function buildPrivateChatPayload(input) {
    const slug = node_path_1.default.basename((0, paths_1.resolveMetabotPaths)(input.homeDir).profileRoot);
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
async function readResponseExcerpt(response) {
    try {
        const body = (await response.text()).replace(/\s+/g, ' ').trim();
        return body ? body.slice(0, MAX_ERROR_BODY_CHARS) : '';
    }
    catch {
        return '';
    }
}
async function postGrokBotWebhook(input) {
    const webhook = input.binding.webhook;
    if (!webhook) {
        return { ok: false, error: 'webhook not configured' };
    }
    const headers = { 'content-type': 'application/json' };
    if (webhook.secret) {
        headers.authorization = `Bearer ${webhook.secret}`;
    }
    let response;
    try {
        response = await input.fetchImpl(webhook.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(input.payload),
            signal: AbortSignal.timeout(input.timeoutMs),
            redirect: 'error',
        });
    }
    catch (error) {
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
function webhookAttemptsPathForProfile(homeDir) {
    return node_path_1.default.join((0, paths_1.resolveMetabotPaths)(homeDir).stateRoot, 'grok-bot-webhook-attempts.json');
}
async function readWebhookAttempts(filePath) {
    try {
        const parsed = JSON.parse(await node_fs_1.promises.readFile(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.attempts && typeof parsed.attempts === 'object') {
            return parsed;
        }
    }
    catch {
        // Missing or corrupt ledger starts empty.
    }
    return { attempts: {} };
}
async function writeWebhookAttempts(filePath, state) {
    // Bound the ledger: keep the most recent entries only.
    const entries = Object.entries(state.attempts)
        .sort((left, right) => right[1].lastAt.localeCompare(left[1].lastAt))
        .slice(0, MAX_ATTEMPT_ENTRIES);
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    await node_fs_1.promises.writeFile(filePath, `${JSON.stringify({ attempts: Object.fromEntries(entries) }, null, 2)}\n`, 'utf8');
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
async function deliverGrokBotPrivateChat(input) {
    const filePath = (0, grokBotBinding_1.grokBotBindingPathForProfile)(input.homeDir);
    const binding = await (0, grokBotBinding_1.readGrokBotBinding)(filePath);
    if (!binding.webhook) {
        return 'not_configured';
    }
    const now = input.now ?? (() => new Date());
    const maxAttempts = Math.max(1, input.maxAttempts ?? exports.GROK_BOT_WEBHOOK_MAX_ATTEMPTS);
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
        timeoutMs: input.timeoutMs ?? exports.GROK_BOT_WEBHOOK_TIMEOUT_MS,
    });
    const at = now().toISOString();
    await (0, grokBotBinding_1.recordGrokBotWebhookDelivery)(filePath, {
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
