/**
 * Quote-reply reference source for the kernel's input-trigger pipeline.
 *
 * The composer draft is kernel-owned, and reference chips are its structured
 * insertion channel: a chip DISPLAYS a short label while the owning source's
 * codec produces the model text at submit time. This module is the
 * `oac-quote` source: the selection overlay inserts one quote chip per pick
 * through the session input facade, and the codec here turns that chip back
 * into the blockquoted passage the bot reads.
 *
 * SELF-CONTAINED REFS (hard invariant): the ref encodes the full model text,
 * so the codec decodes from `ref` alone — no in-memory store, no session
 * lookup, nothing a restored draft in a later app run could fail on. The
 * submit path REJECTS when a codec rejects and then BLOCKS THE SEND, so
 * `serialize` never rejects: a ref that does not decode answers a short safe
 * marker instead.
 *
 * No `lexicon`/`subscribeLexicon` hooks on purpose: scan-derived decoration
 * is not wanted for quote chips.
 */

import type { InputTriggerSource, ReferenceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** Registered source name (the serializer routing key on every quote chip). */
export const QUOTE_REPLY_SOURCE_NAME = 'oac-quote'

/** Ref prefix marking a quote-reply payload; guards against foreign refs. */
const QUOTE_REPLY_REF_PREFIX = 'oac-quote-v1:'

/** Codec answer for a ref that does not decode: short, safe, never empty. */
const QUOTE_REPLY_REF_FALLBACK = '[quoted passage]'

const TEXT_ENCODER = new TextEncoder()
/** Fatal decoding: invalid UTF-8 counts as a failed decode, never mojibake. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * Encode one quote's model text into a self-contained ref: the UTF-8 bytes in
 * base64 behind a versioned prefix. The ref is the ONLY carrier of the
 * passage, so it survives draft persistence without any lookup.
 * @param modelText - the exact text the block composition produced.
 * @returns the ref for one `oac-quote` chip.
 */
export function encodeQuoteReplyRef(modelText: string): string {
  const bytes = TEXT_ENCODER.encode(modelText)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${QUOTE_REPLY_REF_PREFIX}${btoa(binary)}`
}

/**
 * Decode a ref produced by {@link encodeQuoteReplyRef}. Total by design: any
 * malformed input (wrong prefix, invalid base64, invalid UTF-8, empty
 * payload) answers undefined instead of throwing.
 * @param ref - the chip's owner-scoped reference id.
 * @returns the model text, or undefined when the ref does not decode.
 */
function decodeQuoteReplyRef(ref: string): string | undefined {
  if (typeof ref !== 'string' || !ref.startsWith(QUOTE_REPLY_REF_PREFIX)) return undefined
  try {
    const binary = atob(ref.slice(QUOTE_REPLY_REF_PREFIX.length))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const text = TEXT_DECODER.decode(bytes)
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** The codec's single resolution path: decoded text, or the safe marker. */
function resolveQuoteReplyRef(ref: string): string {
  return decodeQuoteReplyRef(ref) ?? QUOTE_REPLY_REF_FALLBACK
}

/**
 * The `oac-quote` trigger source. `candidates` stays empty on purpose — a
 * quote chip is inserted by the selection overlay through the input facade,
 * never picked from a menu; the registration exists so the submit attempt
 * can route the chip's serialization to this codec by source name.
 */
export const QUOTE_REPLY_SOURCE: InputTriggerSource = {
  trigger: '@',
  name: QUOTE_REPLY_SOURCE_NAME,
  order: 99,
  candidates: async () => [],
  onPick: () => undefined,
  codec: {
    clipboardText: (ref) => resolveQuoteReplyRef(ref),
    // Async per the ReferenceCodec contract; the decode is pure and cannot
    // reject, so a send is never blocked by this source.
    serialize: (ref) => Promise.resolve(resolveQuoteReplyRef(ref)),
  },
}

/**
 * Visible chip-label cap, in UTF-16 units. The label is a readability aid
 * only: the ref carries the whole passage, so a shorter label never changes
 * what gets sent.
 */
export const QUOTE_REPLY_CHIP_LABEL_MAX_CHARS = 24

/** Keep the last UTF-16 unit off a cut that would split a surrogate pair. */
function sliceChipLabelSafe(text: string, maxChars: number): string {
  const kept = text.slice(0, maxChars)
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept
}

/**
 * Build the chip's visible label from the picked passage itself: one line,
 * whitespace runs collapsed, cut at `maxChars` with a trailing ellipsis when
 * truncated. Pure and total — a blank (or non-string) passage answers the
 * caller's locale fallback instead of an empty label, and a cut never splits
 * a surrogate pair (mirrors `sliceQuoteReplySafe` in the shared logic).
 * @param text - the picked passage, verbatim.
 * @param fallback - locale copy used when the passage has no visible text.
 * @param maxChars - label cap; defaults to {@link QUOTE_REPLY_CHIP_LABEL_MAX_CHARS}.
 * @returns a non-empty single-line label.
 */
export function buildQuoteReplyChipLabel(
  text: string,
  fallback: string,
  maxChars: number = QUOTE_REPLY_CHIP_LABEL_MAX_CHARS,
): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  if (flat === '') return fallback
  const cap = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : QUOTE_REPLY_CHIP_LABEL_MAX_CHARS
  if (flat.length <= cap) return flat
  return `${sliceChipLabelSafe(flat, cap).trimEnd()}…`
}

/** The composer faces one quote-chip insert rides (span capture + reference insert). */
export interface QuoteReferenceInsertTarget<Span> {
  captureInsertion(): Span
  insertReference(insert: ReferenceInsert, span: Span): boolean
}

export interface QuoteReferenceInsertOutcome {
  ok: boolean
  /** Captures performed: 1 when the first insert was accepted, 2 after the retry. */
  attempts: number
}

/**
 * Capture → insert for one quote chip; a refused insert (the draft changed,
 * or submission locked the editor) re-captures once and retries with the
 * FRESH span. The chip is never dropped silently — callers must surface a
 * visible notice when both attempts fail. Mirrors `insertQuoteIntoDraft`'s
 * discipline for the reference channel.
 * @param target - the composer faces: span capture from the slot action
 *   face, the chip insert through the session input facade.
 * @param insertOf - composes the chip payload per attempt from that
 *   attempt's span (the block composition reads `span.start`).
 */
export function insertQuoteReferenceIntoDraft<Span>(
  target: QuoteReferenceInsertTarget<Span>,
  insertOf: (span: Span) => ReferenceInsert,
): QuoteReferenceInsertOutcome {
  const first = target.captureInsertion()
  if (target.insertReference(insertOf(first), first)) return { ok: true, attempts: 1 }
  const second = target.captureInsertion()
  if (target.insertReference(insertOf(second), second)) return { ok: true, attempts: 2 }
  return { ok: false, attempts: 2 }
}
