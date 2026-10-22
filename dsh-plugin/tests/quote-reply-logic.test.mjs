/**
 * Quote-reply core logic (src/quote-reply-logic.ts -> lib/quote-reply-logic.js).
 *
 * The kernel owns the draft and its reference chips; this module only builds
 * the appended blockquote text and drives the capture/insert/retry sequence
 * over the public input action face. The DOM glue lives in the client
 * component (quote-reply-overlay.test.mjs).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const here = path.dirname(new URL(import.meta.url).pathname)
const pluginRoot = path.join(here, '..')
const logic = require(path.join(pluginRoot, 'lib', 'quote-reply-logic.js'))

/** zh-Hans labels for the block template (what the component passes from i18n). */
const ZH_LABELS = {
  source: '引用{role}消息{streaming}：',
  roleUser: '用户',
  roleBot: 'bot',
  streamingMark: ' · 该条仍在生成中',
  truncatedNote: '（摘录已截断，省略 {omitted} 字）',
}

/** en labels; the header is role-only there too. */
const EN_LABELS = {
  source: 'Quoted {role} message{streaming}:',
  roleUser: 'user',
  roleBot: 'bot',
  streamingMark: ' · still being generated',
  truncatedNote: '(excerpt truncated; {omitted} characters omitted)',
}

test('resolveQuoteReplyTarget: empty or whitespace-only selections produce nothing', () => {
  const base = { kind: 'assistant-step', streaming: false }
  assert.equal(logic.resolveQuoteReplyTarget({ ...base, text: '' }), undefined)
  assert.equal(logic.resolveQuoteReplyTarget({ ...base, text: '   \n\t ' }), undefined)
})

test('resolveQuoteReplyTarget: only role-bearing message kinds are quotable', () => {
  // Transcript is content, but a tool/process block carries no citable role.
  assert.equal(
    logic.resolveQuoteReplyTarget({ kind: 'turn-process', text: 'x', streaming: false }),
    undefined,
  )
  assert.equal(
    logic.resolveQuoteReplyTarget({ kind: undefined, text: 'x', streaming: false }),
    undefined,
  )
})

// Converted from the deleted ordinal coverage: the counter is gone end to end,
// so the resolution test now pins that NO position field exists on a target
// (a reappearing ordinal would break this test, not slip through).
test('resolveQuoteReplyTarget: role resolution — no message ordinal is resolved or carried', () => {
  const assistant = logic.resolveQuoteReplyTarget({ kind: 'assistant-step', text: '  引用这段  ', streaming: false })
  assert.deepEqual(assistant, { role: 'assistant', text: '引用这段', streaming: false })
  const user = logic.resolveQuoteReplyTarget({ kind: 'user', text: 'q', streaming: false })
  assert.deepEqual(user, { role: 'user', text: 'q', streaming: false })
  // Steering is a user-side message and resolves like one.
  const steering = logic.resolveQuoteReplyTarget({ kind: 'steering', text: 's', streaming: false })
  assert.deepEqual(steering, { role: 'user', text: 's', streaming: false })
  // The counting helper is removed from the module surface.
  assert.equal(logic.quoteReplyPositionOf, undefined)
  assert.ok(!('position' in assistant), 'a target never carries a position again')
})

test('resolveQuoteReplyTarget: streaming passes through (the pick is frozen at click time)', () => {
  const target = logic.resolveQuoteReplyTarget({
    kind: 'assistant-step',
    text: 'still writing',
    streaming: true,
  })
  assert.equal(target.streaming, true)
})

test('normalizeQuoteReplyExcerpt: verbatim under the cap, with CRLF and trailing-space tidying', () => {
  assert.deepEqual(logic.normalizeQuoteReplyExcerpt('line one\r\nline two  '), {
    excerpt: 'line one\nline two',
    truncated: false,
    omitted: 0,
  })
  assert.deepEqual(logic.normalizeQuoteReplyExcerpt('\n\nhello\n\n'), { excerpt: 'hello', truncated: false, omitted: 0 })
})

test('normalizeQuoteReplyExcerpt: over the cap truncates explicitly and counts the omitted tail', () => {
  const text = 'a'.repeat(30)
  const result = logic.normalizeQuoteReplyExcerpt(text, 10)
  assert.equal(result.truncated, true)
  assert.equal(result.excerpt, 'a'.repeat(10))
  assert.equal(result.omitted, 20)
})

test('normalizeQuoteReplyExcerpt: never cuts a surrogate pair in half', () => {
  // 9 plain chars then one astral character (2 UTF-16 units): a cut at 10
  // would split it, so the kept length drops to 9.
  const text = `${'b'.repeat(9)}\u{1F600}tail`
  const result = logic.normalizeQuoteReplyExcerpt(text, 10)
  assert.equal(result.truncated, true)
  assert.equal(result.excerpt, 'b'.repeat(9))
  assert.equal(result.omitted, text.length - 9)
  // No lone surrogates anywhere in the kept text.
  assert.doesNotMatch(result.excerpt, /[\uD800-\uDBFF]$/)
})

test('summarizeQuoteReplyExcerpt: one-line summary for the quote bar', () => {
  assert.equal(logic.summarizeQuoteReplyExcerpt('first line\nsecond\tline'), 'first line second line')
  const long = logic.summarizeQuoteReplyExcerpt('x'.repeat(200), 96)
  assert.equal(long.length, 97) // 96 chars + the ellipsis
  assert.ok(long.endsWith('…'))
})

test('buildQuoteReplyBlock: blockquote block with source header, excerpt, trailing newline', () => {
  const block = logic.buildQuoteReplyBlock(
    { role: 'assistant', text: '我们先把靶心写成一句委托人能看懂的话，再开始扣扳机。', streaming: false, draftNonEmpty: false, insertAtStart: true },
    ZH_LABELS,
  )
  assert.equal(
    block,
    '> 引用bot消息：\n> 我们先把靶心写成一句委托人能看懂的话，再开始扣扳机。\n',
  )
})

// Regression guard for the owner's decision: the sent header names only the
// ROLE — the quoted text is the sole source identifier. The counting scheme
// that produced `第 N 条` counted reasoning steps as messages, so it is gone
// and must never come back. Every shape fact (per-line `> ` prefix, blank-line
// separator, truncation note, trailing newline) is asserted byte for byte.
test('buildQuoteReplyBlock: regression — the header carries no ordinal, the quoted text is the only identifier', () => {
  const cases = [
    {
      block: logic.buildQuoteReplyBlock(
        { role: 'assistant', text: 'quoted passage', streaming: false, draftNonEmpty: false, insertAtStart: true },
        ZH_LABELS,
      ),
      expected: '> 引用bot消息：\n> quoted passage\n',
    },
    {
      block: logic.buildQuoteReplyBlock(
        { role: 'assistant', text: 'quoted passage', streaming: true, draftNonEmpty: false, insertAtStart: true },
        ZH_LABELS,
      ),
      expected: '> 引用bot消息 · 该条仍在生成中：\n> quoted passage\n',
    },
    {
      block: logic.buildQuoteReplyBlock(
        { role: 'user', text: 'quoted passage', streaming: false, draftNonEmpty: false, insertAtStart: true },
        EN_LABELS,
      ),
      expected: '> Quoted user message:\n> quoted passage\n',
    },
    {
      block: logic.buildQuoteReplyBlock(
        { role: 'assistant', text: 'a'.repeat(30), streaming: false, draftNonEmpty: true, insertAtStart: false },
        ZH_LABELS,
        10,
      ),
      expected: `\n\n> 引用bot消息：\n> ${'a'.repeat(10)}\n> （摘录已截断，省略 20 字）\n`,
    },
  ]
  for (const { block, expected } of cases) {
    assert.doesNotMatch(block, /第\s*\d+\s*条/, `no zh ordinal in ${JSON.stringify(block)}`)
    assert.doesNotMatch(block, /#\d+/, `no en ordinal in ${JSON.stringify(block)}`)
    assert.equal(block, expected)
  }
})

test('buildQuoteReplyBlock: appending after existing draft text gets a blank-line separator', () => {
  const block = logic.buildQuoteReplyBlock(
    { role: 'user', text: 'hello', streaming: false, draftNonEmpty: true, insertAtStart: false },
    ZH_LABELS,
  )
  assert.ok(block.startsWith('\n\n> 引用用户消息：\n> hello\n'))
  // An empty draft is not "existing text" — no separator even mid-flow.
  const clean = logic.buildQuoteReplyBlock(
    { role: 'user', text: 'hello', streaming: false, draftNonEmpty: false, insertAtStart: false },
    ZH_LABELS,
  )
  assert.ok(clean.startsWith('> 引用用户消息'))
})

test('buildQuoteReplyBlock: inserting at the draft start puts the block above existing text without blank lines', () => {
  const block = logic.buildQuoteReplyBlock(
    { role: 'user', text: 'hello', streaming: false, draftNonEmpty: true, insertAtStart: true },
    ZH_LABELS,
  )
  assert.ok(block.startsWith('> 引用用户消息'))
  assert.ok(!block.startsWith('\n'))
})

test('buildQuoteReplyBlock: streaming source carries the explicit in-generation mark', () => {
  const block = logic.buildQuoteReplyBlock(
    { role: 'assistant', text: '…', streaming: true, draftNonEmpty: false, insertAtStart: true },
    ZH_LABELS,
  )
  assert.ok(block.startsWith('> 引用bot消息 · 该条仍在生成中：\n'))
})

test('buildQuoteReplyBlock: multi-line excerpts keep the blockquote prefix on every line', () => {
  const block = logic.buildQuoteReplyBlock(
    { role: 'user', text: 'one\ntwo\nthree', streaming: false, draftNonEmpty: false, insertAtStart: true },
    ZH_LABELS,
  )
  assert.equal(block, '> 引用用户消息：\n> one\n> two\n> three\n')
})

test('buildQuoteReplyBlock: over-limit excerpts carry the explicit truncation note', () => {
  const block = logic.buildQuoteReplyBlock(
    { role: 'assistant', text: 'a'.repeat(30), streaming: false, draftNonEmpty: false, insertAtStart: true },
    ZH_LABELS,
    10,
  )
  assert.equal(
    block,
    `> 引用bot消息：\n> ${'a'.repeat(10)}\n> （摘录已截断，省略 20 字）\n`,
  )
})

test('buildQuoteReplyBlock: en labels compose the same shape', () => {
  const block = logic.buildQuoteReplyBlock(
    { role: 'assistant', text: 'hello', streaming: false, draftNonEmpty: false, insertAtStart: true },
    EN_LABELS,
  )
  assert.equal(block, '> Quoted bot message:\n> hello\n')
})

test('insertQuoteIntoDraft: first accepted insert is a single capture/insert step', () => {
  const calls = []
  const target = {
    captureInsertion: () => {
      calls.push('capture')
      return { start: 5, end: 5, draftRev: 1 }
    },
    insertText: (text, span) => {
      calls.push(`insert:${text}:${span.draftRev}`)
      return true
    },
  }
  const outcome = logic.insertQuoteIntoDraft(target, () => 'BLOCK')
  assert.deepEqual(outcome, { ok: true, attempts: 1 })
  assert.deepEqual(calls, ['capture', 'insert:BLOCK:1'])
})

test('insertQuoteIntoDraft: a stale-revision refusal re-captures once and retries', () => {
  const spans = [
    { start: 5, end: 5, draftRev: 1 },
    { start: 9, end: 9, draftRev: 2 }, // the draft moved between attempts
  ]
  let captures = 0
  const seen = []
  const target = {
    captureInsertion: () => spans[captures++],
    insertText: (text, span) => {
      seen.push({ text, span })
      return span.draftRev === 2 // only the fresh span is accepted
    },
  }
  const outcome = logic.insertQuoteIntoDraft(target, (span) => `BLOCK@${span.draftRev}`)
  assert.deepEqual(outcome, { ok: true, attempts: 2 })
  assert.equal(captures, 2)
  assert.deepEqual(seen.map((call) => call.text), ['BLOCK@1', 'BLOCK@2'])
  assert.equal(seen[1].span, spans[1]) // the retry uses the FRESH span, never the stale one
})

test('insertQuoteIntoDraft: two refusals report failure instead of silently dropping the quote', () => {
  let captures = 0
  const target = {
    captureInsertion: () => {
      captures += 1
      return { start: 0, end: 0, draftRev: captures }
    },
    insertText: () => false,
  }
  const outcome = logic.insertQuoteIntoDraft(target, () => 'BLOCK')
  assert.deepEqual(outcome, { ok: false, attempts: 2 })
  assert.equal(captures, 2)
})

// Coexistence model: the kernel contract inserts text at the captured span in
// one undo step and never clears existing content or reference chips. The
// fake below mirrors exactly that append semantics; the helper must keep the
// pre-existing chip text and typed text intact.
test('insertQuoteIntoDraft: appends beside existing draft text and reference chips', () => {
  const chipText = '@file:notes.md'
  const typed = 'please summarize '
  let draft = `${typed}${chipText}`
  let setDraftCalls = 0 // the draft-replacing verb must never be used
  const target = {
    captureInsertion: () => ({ start: draft.length, end: draft.length, draftRev: draft.length }),
    insertText: (text, span) => {
      if (span.start > draft.length) return false
      draft = draft.slice(0, span.start) + text + draft.slice(span.end)
      return true
    },
    setDraft: () => {
      setDraftCalls += 1
    },
  }
  const outcome = logic.insertQuoteIntoDraft(target, () =>
    logic.buildQuoteReplyBlock(
      { role: 'assistant', text: 'quoted passage', streaming: false, draftNonEmpty: draft !== '', insertAtStart: draft.length === 0 },
      ZH_LABELS,
    ),
  )
  assert.deepEqual(outcome, { ok: true, attempts: 1 })
  assert.equal(setDraftCalls, 0)
  assert.ok(draft.startsWith(`${typed}${chipText}\n\n> 引用bot消息：\n> quoted passage\n`))
  assert.ok(draft.includes(chipText), 'the pre-existing reference chip text must survive')
  assert.ok(draft.includes(typed), 'the pre-existing typed text must survive')
})

test('asQuoteInsertTarget: absent or partial action faces degrade to undefined (feature detection)', () => {
  assert.equal(logic.asQuoteInsertTarget(undefined), undefined)
  assert.equal(logic.asQuoteInsertTarget(null), undefined)
  assert.equal(logic.asQuoteInsertTarget({}), undefined)
  assert.equal(logic.asQuoteInsertTarget({ captureInsertion: () => 1 }), undefined)
  assert.equal(logic.asQuoteInsertTarget({ insertText: () => true }), undefined)
  const full = { captureInsertion: () => 1, insertText: () => true }
  assert.equal(logic.asQuoteInsertTarget(full), full)
})
