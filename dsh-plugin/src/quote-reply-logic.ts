/**
 * Shared quote-reply logic (host-agnostic; no DOM or Node APIs).
 *
 * DSH keeps the composer draft and its reference chips inside the kernel, and
 * offers no message-level action slots — a transcript passage can only be
 * picked through a text selection, and the result can only be APPENDED to the
 * kernel-owned draft. This module owns what is testable without a DOM:
 * resolving a citable (role + position) target from transcript facts, capping
 * and shaping the excerpt, composing the blockquote text, the
 * capture/insert/retry sequence over the public input action face, and the
 * action-face feature probe.
 */

/** Selected text longer than this is truncated before it enters the draft. */
export const QUOTE_REPLY_EXCERPT_MAX_CHARS = 4000

/** One-line preview cap for the quote bar. */
export const QUOTE_REPLY_PREVIEW_MAX_CHARS = 96

/** Citable role of one transcript message. */
export type QuoteReplyRole = 'user' | 'assistant'

/**
 * Chat flow kinds (`data-chat-flow-kind`) that carry a citable role:
 * user-side messages and assistant output steps. Tool/process/notice flow
 * items are transcript content too, but they have no role or message ordinal
 * to cite — quoting them would have to invent provenance, so the selector
 * does not offer them.
 */
export const QUOTE_REPLY_USER_KINDS: readonly string[] = ['user', 'steering']
export const QUOTE_REPLY_ASSISTANT_KINDS: readonly string[] = ['assistant-step']

export function quoteReplyRoleOfKind(kind: string): QuoteReplyRole | undefined {
  if (QUOTE_REPLY_USER_KINDS.includes(kind)) return 'user'
  if (QUOTE_REPLY_ASSISTANT_KINDS.includes(kind)) return 'assistant'
  return undefined
}

/** One frozen quote pick: where it came from and the verbatim passage. */
export interface QuoteReplyTarget {
  role: QuoteReplyRole
  /** 1-based position among the transcript's message items, as rendered. */
  position: number
  /** Verbatim selected text, trimmed. */
  text: string
  /** Whether the source message was still generating when the passage was picked. */
  streaming: boolean
}

/** The DOM facts one transcript selection resolves to (read by the component). */
export interface QuoteReplyPick {
  /** `data-chat-flow-kind` of the flow item holding the selection. */
  kind: string | undefined
  /** Every flow kind in the same transcript scrollport, in document order. */
  kinds: readonly string[]
  /** Index of the selection's flow item inside `kinds`. */
  ownIndex: number
  /** Selection text. */
  text: string
  /** Whether the flow item shows a live-generation marker. */
  streaming: boolean
}

/**
 * 1-based ordinal of `ownIndex` among the message-kind flow items — how a
 * person would count message ordinals while reading the rendered transcript.
 * @param kinds - flow kinds in document order.
 * @param ownIndex - index of the flow item being cited.
 * @returns the ordinal, or undefined when the index is detached.
 */
export function quoteReplyPositionOf(kinds: readonly string[], ownIndex: number): number | undefined {
  if (ownIndex < 0 || ownIndex >= kinds.length) return undefined
  let position = 0
  for (let index = 0; index <= ownIndex; index += 1) {
    if (quoteReplyRoleOfKind(kinds[index]) !== undefined) position += 1
  }
  return position === 0 ? undefined : position
}

/**
 * Resolve one selection into a quotable target. Empty selections produce
 * nothing; non-message flow items and detached items are not citable.
 */
export function resolveQuoteReplyTarget(pick: QuoteReplyPick): QuoteReplyTarget | undefined {
  const role = pick.kind === undefined ? undefined : quoteReplyRoleOfKind(pick.kind)
  if (role === undefined) return undefined
  const text = pick.text.trim()
  if (text === '') return undefined
  const position = quoteReplyPositionOf(pick.kinds, pick.ownIndex)
  if (position === undefined) return undefined
  return { role, position, text, streaming: pick.streaming }
}

/** A capped excerpt and what the cap dropped. */
export interface QuoteReplyExcerpt {
  excerpt: string
  truncated: boolean
  /** UTF-16 units dropped off the tail (0 when not truncated). */
  omitted: number
}

/** Strip trailing whitespace per line and the text's outer blank lines; never mid-text. */
function tidyQuoteReplyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** Keep the last UTF-16 unit off a cut that would split a surrogate pair. */
function sliceQuoteReplySafe(text: string, maxChars: number): string {
  const kept = text.slice(0, maxChars)
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept
}

/** Cap an excerpt; over-limit text is truncated with its dropped size reported. */
export function normalizeQuoteReplyExcerpt(
  text: string,
  maxChars: number = QUOTE_REPLY_EXCERPT_MAX_CHARS,
): QuoteReplyExcerpt {
  const tidy = tidyQuoteReplyText(text)
  if (tidy.length <= maxChars) return { excerpt: tidy, truncated: false, omitted: 0 }
  const excerpt = sliceQuoteReplySafe(tidy, maxChars)
  return { excerpt, truncated: true, omitted: tidy.length - excerpt.length }
}

/** Collapse a passage into one capped line for the quote bar. */
export function summarizeQuoteReplyExcerpt(
  text: string,
  maxChars: number = QUOTE_REPLY_PREVIEW_MAX_CHARS,
): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${sliceQuoteReplySafe(flat, maxChars).trimEnd()}…`
}

/** i18n templates and role nouns the block composes from (values pre-translated). */
export interface QuoteReplyLabels {
  /** Header template, e.g. `Quoted {role} message (#{position}{streaming}):`. */
  source: string
  roleUser: string
  roleAssistant: string
  /** Substituted into `{streaming}` while the source is still generating. */
  streamingMark: string
  /** Truncation-note template, e.g. `(excerpt truncated; {omitted} characters omitted)`. */
  truncatedNote: string
}

/** Fill `{name}` placeholders; unknown placeholders stay verbatim. */
function formatQuoteReplyTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/gi, (match, name: string) => vars[name] ?? match)
}

/** Facts the block composes from; see {@link buildQuoteReplyBlock}. */
export interface QuoteReplyBlockInput {
  role: QuoteReplyRole
  position: number
  /** Verbatim picked text; trimmed and capped here. */
  text: string
  streaming: boolean
  /** Whether the draft already holds text (`InputState.draft`, trimmed). */
  draftNonEmpty: boolean
  /** Whether the insertion point sits at the draft start (`span.start === 0`). */
  insertAtStart: boolean
}

/**
 * Compose the text one pick APPENDS to the kernel draft: a blockquoted source
 * header (role + position, with the in-generation mark when the source is
 * still streaming), the capped excerpt, and an explicit truncation note when
 * the cap dropped text. The text ends with a newline so typing continues
 * below the block; a blank-line separator keeps an existing draft readable.
 * @param input - pick facts; see {@link QuoteReplyBlockInput}.
 * @param labels - pre-translated templates; see {@link QuoteReplyLabels}.
 * @param maxChars - excerpt cap; defaults to {@link QUOTE_REPLY_EXCERPT_MAX_CHARS}.
 * @returns the exact text to insert, never empty.
 */
export function buildQuoteReplyBlock(
  input: QuoteReplyBlockInput,
  labels: QuoteReplyLabels,
  maxChars: number = QUOTE_REPLY_EXCERPT_MAX_CHARS,
): string {
  const header = formatQuoteReplyTemplate(labels.source, {
    role: input.role === 'user' ? labels.roleUser : labels.roleAssistant,
    position: String(input.position),
    streaming: input.streaming ? labels.streamingMark : '',
  })
  const { excerpt, truncated, omitted } = normalizeQuoteReplyExcerpt(input.text, maxChars)
  const lines = [header, ...excerpt.split('\n')]
  if (truncated) lines.push(formatQuoteReplyTemplate(labels.truncatedNote, { omitted: String(omitted) }))
  const block = lines.map((line) => `> ${line}`).join('\n')
  const separator = input.draftNonEmpty && !input.insertAtStart ? '\n\n' : ''
  return `${separator}${block}\n`
}

/**
 * The subset of the kernel's public input action face this feature uses
 * (`InputActions` at runtime; kept structural so the sequence stays testable
 * without the kernel).
 */
export interface QuoteInsertTarget<Span> {
  captureInsertion(): Span
  insertText(text: string, span: Span): boolean
}

export interface QuoteInsertOutcome {
  ok: boolean
  /** Captures performed: 1 when the first insert was accepted, 2 after the retry. */
  attempts: number
}

/**
 * Capture → insert; a refused insert (the draft changed, or submission locked
 * the editor) re-captures once and retries with the FRESH span. The quote is
 * never dropped silently — callers must surface a visible notice when both
 * attempts fail.
 * @param target - the session's input action face.
 * @param textOf - composes the text per attempt from that attempt's span.
 */
export function insertQuoteIntoDraft<Span>(
  target: QuoteInsertTarget<Span>,
  textOf: (span: Span) => string,
): QuoteInsertOutcome {
  const first = target.captureInsertion()
  if (target.insertText(textOf(first), first)) return { ok: true, attempts: 1 }
  const second = target.captureInsertion()
  if (target.insertText(textOf(second), second)) return { ok: true, attempts: 2 }
  return { ok: false, attempts: 2 }
}

/**
 * Feature probe for the input action face. Another kernel line may not
 * provide it to this slot's occupants; a partial or absent face must hide the
 * whole feature instead of throwing or rendering half-dead UI.
 */
export function asQuoteInsertTarget<Span>(actions: unknown): QuoteInsertTarget<Span> | undefined {
  if (typeof actions !== 'object' || actions === null) return undefined
  const candidate = actions as Partial<QuoteInsertTarget<Span>>
  if (typeof candidate.captureInsertion !== 'function') return undefined
  if (typeof candidate.insertText !== 'function') return undefined
  return candidate as QuoteInsertTarget<Span>
}
