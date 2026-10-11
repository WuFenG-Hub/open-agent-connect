import type { PrivateChatInboundMessage } from '../chat/privateChatTypes';
import { type GrokBotBinding } from './grokBotBinding';
export type GrokBotWebhookDeliveryOutcome = 'delivered' | 'not_configured' | 'failed'
/** Attempt budget exhausted: the message is handed to the relay ledger so the backfill stops re-driving it. */
 | 'gave_up';
export declare const GROK_BOT_WEBHOOK_TIMEOUT_MS = 15000;
/** Bounded redelivery: the backfill sweep naturally spaces retries minutes apart; after this many failed attempts the message is marked as relayed anyway (and the failure stays visible in the binding ledger). */
export declare const GROK_BOT_WEBHOOK_MAX_ATTEMPTS = 3;
export declare function postGrokBotWebhook(input: {
    binding: GrokBotBinding;
    payload: Record<string, unknown>;
    fetchImpl: typeof fetch;
    timeoutMs: number;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
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
export declare function deliverGrokBotPrivateChat(input: {
    homeDir: string;
    message: PrivateChatInboundMessage;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxAttempts?: number;
    now?: () => Date;
}): Promise<GrokBotWebhookDeliveryOutcome>;
