/**
 * Quote-reply reference source (src/client/quote-reply-source.ts).
 *
 * The source's codec is the submit-time serializer for `oac-quote` chips: a
 * persisted ref must decode from itself alone, and `serialize` must NEVER
 * reject (a rejection blocks the send). These tests execute the module
 * directly — Node strips the types — so the invariant is proven, not just
 * pattern-matched. The retry discipline for the chip insert is proven the
 * same way.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  QUOTE_REPLY_CHIP_LABEL_MAX_CHARS,
  QUOTE_REPLY_SOURCE,
  QUOTE_REPLY_SOURCE_NAME,
  buildQuoteReplyChipLabel,
  encodeQuoteReplyRef,
  insertQuoteReferenceIntoDraft,
} from '../src/client/quote-reply-source.ts'
import { buildQuoteReplyBlock } from '../src/quote-reply-logic.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIGNAL = new AbortController().signal

test('source: oac-quote on the @ trigger, empty candidate roster, no lexicon hooks', async () => {
  assert.equal(QUOTE_REPLY_SOURCE.trigger, '@')
  assert.equal(QUOTE_REPLY_SOURCE.name, 'oac-quote')
  assert.equal(QUOTE_REPLY_SOURCE_NAME, 'oac-quote')
  assert.equal(QUOTE_REPLY_SOURCE.order, 99)
  assert.deepEqual(await QUOTE_REPLY_SOURCE.candidates(), [])
  assert.equal(QUOTE_REPLY_SOURCE.onPick(), undefined)
  assert.equal(typeof QUOTE_REPLY_SOURCE.codec.clipboardText, 'function')
  assert.equal(typeof QUOTE_REPLY_SOURCE.codec.serialize, 'function')
  // No scan-derived decoration: neither lexicon hook is implemented.
  assert.equal(QUOTE_REPLY_SOURCE.lexicon, undefined)
  assert.equal(QUOTE_REPLY_SOURCE.subscribeLexicon, undefined)
})

test('codec: the ref round-trips the exact blockquote block, byte for byte', async () => {
  // The model text is produced by the UNCHANGED block composition — the same
  // call the overlay makes — so the sent shape is pinned end to end.
  const block = buildQuoteReplyBlock(
    { role: 'assistant', text: '我们先把靶心写成一句委托人能看懂的话，再开始扣扳机。', streaming: false, draftNonEmpty: false, insertAtStart: true },
    {
      source: '引用{role}消息{streaming}：',
      roleUser: '用户',
      roleBot: 'bot',
      streamingMark: ' · 该条仍在生成中',
      truncatedNote: '（摘录已截断，省略 {omitted} 字）',
    },
  )
  // What actually leaves the composer carries the role only — no ordinal.
  assert.doesNotMatch(block, /第\s*\d+\s*条/)
  assert.equal(block, '> 引用bot消息：\n> 我们先把靶心写成一句委托人能看懂的话，再开始扣扳机。\n')
  const ref = encodeQuoteReplyRef(block)
  assert.ok(ref.startsWith('oac-quote-v1:'))
  assert.equal(QUOTE_REPLY_SOURCE.codec.clipboardText(ref), block)
  assert.equal(await QUOTE_REPLY_SOURCE.codec.serialize(ref, SIGNAL), block)
  // Deterministic encoding: same text, same ref (nothing stateful).
  assert.equal(encodeQuoteReplyRef(block), ref)
})

test('codec: serialize resolves (never rejects) on garbage refs, answering a short safe marker', async () => {
  const garbage = [
    '',
    'garbage',
    'https://example.com/not-a-ref',
    'oac-quote-v1:',
    'oac-quote-v1:!!!!',
    'oac-quote-v1:gA==', // valid base64, invalid UTF-8
    '\u0000\u0001',
  ]
  for (const ref of garbage) {
    // The hard invariant: a rejection here would BLOCK the send.
    await assert.doesNotReject(() => QUOTE_REPLY_SOURCE.codec.serialize(ref, SIGNAL))
    const serialized = await QUOTE_REPLY_SOURCE.codec.serialize(ref, SIGNAL)
    const clipboard = QUOTE_REPLY_SOURCE.codec.clipboardText(ref)
    assert.equal(serialized, clipboard, `same answer for ${JSON.stringify(ref)}`)
    assert.ok(serialized.length > 0, `non-empty marker for ${JSON.stringify(ref)}`)
    assert.ok(serialized.length <= 64, `short marker for ${JSON.stringify(ref)}`)
  }
})

test('module: the codec is self-contained — type-only imports, no runtime state', async () => {
  const text = await readFile(join(root, 'src/client/quote-reply-source.ts'), 'utf8')
  // The ref is the ONLY carrier of the passage: no store, no lookup tables.
  for (const line of text.split('\n')) {
    if (line.startsWith('import ')) assert.match(line, /^import type /)
  }
  assert.doesNotMatch(text, /new Map\(|new Set\(/)
})

test('insertQuoteReferenceIntoDraft: first accepted insert is a single capture/insert step', () => {
  const calls = []
  const target = {
    captureInsertion: () => {
      calls.push('capture')
      return { start: 5, end: 5, draftRev: 1 }
    },
    insertReference: (insert, span) => {
      calls.push(`insert:${insert.ref}:${span.draftRev}`)
      return true
    },
  }
  const outcome = insertQuoteReferenceIntoDraft(target, () => ({ source: 'oac-quote', ref: 'REF', label: 'L', clipboardText: 'T' }))
  assert.deepEqual(outcome, { ok: true, attempts: 1 })
  assert.deepEqual(calls, ['capture', 'insert:REF:1'])
})

test('insertQuoteReferenceIntoDraft: a stale-revision refusal re-captures once and retries with the FRESH span', () => {
  const spans = [
    { start: 5, end: 5, draftRev: 1 },
    { start: 9, end: 9, draftRev: 2 }, // the draft moved between attempts
  ]
  let captures = 0
  const seen = []
  const target = {
    captureInsertion: () => spans[captures++],
    insertReference: (insert, span) => {
      seen.push({ insert, span })
      return span.draftRev === 2 // only the fresh span is accepted
    },
  }
  const outcome = insertQuoteReferenceIntoDraft(target, (span) => ({ source: 'oac-quote', ref: `REF@${span.draftRev}`, label: 'L', clipboardText: 'T' }))
  assert.deepEqual(outcome, { ok: true, attempts: 2 })
  assert.equal(captures, 2)
  // The payload is composed per attempt from THAT attempt's span.
  assert.deepEqual(seen.map((call) => call.insert.ref), ['REF@1', 'REF@2'])
  assert.equal(seen[1].span, spans[1]) // the retry uses the FRESH span, never the stale one
})

test('insertQuoteReferenceIntoDraft: two refusals report failure instead of silently dropping the chip', () => {
  let captures = 0
  const target = {
    captureInsertion: () => {
      captures += 1
      return { start: 0, end: 0, draftRev: captures }
    },
    insertReference: () => false,
  }
  const outcome = insertQuoteReferenceIntoDraft(target, () => ({ source: 'oac-quote', ref: 'REF', label: 'L', clipboardText: 'T' }))
  assert.deepEqual(outcome, { ok: false, attempts: 2 })
  assert.equal(captures, 2)
})

test('chip label: the exported cap is the single source of the cut length', () => {
  assert.equal(QUOTE_REPLY_CHIP_LABEL_MAX_CHARS, 24)
  const label = buildQuoteReplyChipLabel('x'.repeat(30), 'FALLBACK')
  // Cap chars kept, plus exactly one ellipsis.
  assert.equal(label, `${'x'.repeat(QUOTE_REPLY_CHIP_LABEL_MAX_CHARS)}…`)
  assert.equal(label.length, QUOTE_REPLY_CHIP_LABEL_MAX_CHARS + 1)
})

test('chip label: whitespace collapses to single spaces, ends trim, short text carries no ellipsis', () => {
  assert.equal(buildQuoteReplyChipLabel('  a \n\t b  ', 'FALLBACK'), 'a b')
  assert.equal(buildQuoteReplyChipLabel('transcript\n上有没有稳定', 'FALLBACK'), 'transcript 上有没有稳定')
})

test('chip label: an over-cap passage cuts at the cap and appends one ellipsis', () => {
  assert.equal(buildQuoteReplyChipLabel('abcdefghijklmnopqrstuvwxyz', 'FALLBACK', 10), 'abcdefghij…')
  // A custom cap is honored exactly; the kept prefix never exceeds it.
  const label = buildQuoteReplyChipLabel('y'.repeat(50), 'FALLBACK', 7)
  assert.equal(label, `${'y'.repeat(7)}…`)
})

test('chip label: a cut never splits a surrogate pair', () => {
  // 9 plain units then one astral character (2 UTF-16 units): a cut at 10
  // lands mid-pair, so the kept prefix drops to 9 and the ellipsis follows.
  const text = `${'b'.repeat(9)}\u{1F600}tail`
  const label = buildQuoteReplyChipLabel(text, 'FALLBACK', 10)
  assert.equal(label, `${'b'.repeat(9)}…`)
  assert.doesNotMatch(label, /[\uD800-\uDBFF]…$/)
})

test('chip label: total — blank input answers the locale fallback, never an empty label', () => {
  for (const blank of ['', '   ', '\n\t \r\n']) {
    assert.equal(buildQuoteReplyChipLabel(blank, '引文'), '引文')
  }
  // Runtime totality: a non-string or degenerate cap must not throw.
  assert.equal(buildQuoteReplyChipLabel(undefined, 'FALLBACK'), 'FALLBACK')
  assert.equal(buildQuoteReplyChipLabel('abc', 'FALLBACK', 0), 'a…')
  assert.equal(buildQuoteReplyChipLabel('abc', 'FALLBACK', Number.NaN), 'abc')
})
