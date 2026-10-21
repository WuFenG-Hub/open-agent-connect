/**
 * Selection-driven quote reply — client wiring and dictionary checks.
 *
 * The runtime behaviour of the pure logic lives in quote-reply-logic.test.mjs
 * and the reference source's codec in quote-reply-source.test.mjs; this file
 * pins the wiring a source read can prove: the slot/registration shape, the
 * reference-source registration, the feature-detection guards, the chip
 * insert call sites, the transcript DOM markers, and en/zh dictionary parity
 * (which the typed locale registration also enforces at compile time).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(join(root, relative), 'utf8')

const COMPONENT = 'src/client/QuoteReplyOverlay.tsx'
const LOGIC = 'src/quote-reply-logic.ts'

test('quote reply registers one additive conversation.input.dock entry, gated by the slot declaration', async () => {
  const index = await read('src/client/index.ts')
  assert.match(index, /import \{ QuoteReplyOverlay, type QuoteReplyInjected \} from '\.\/QuoteReplyOverlay\.tsx'/)
  // The feature waits for the kernel's declaration: slots.inject only runs
  // its callback while the slot exists, so a kernel line without the dock
  // slot gets no registration at all.
  assert.match(index, /scope\.slots\.inject\('conversation\.input\.dock', \(\) => scope\.slots\.register\(\{/)
  assert.match(index, /name: 'conversation\.input\.dock',\n\s+id: 'oac-quote-reply',\n\s+order: 30,/)
  // The bar must not drift back to the zero-height overlay anchor — that
  // container is exactly the overlap it moved out of.
  assert.doesNotMatch(index, /conversation\.input\.overlay/)
  assert.match(index, /locale: QR_NS,/)
  assert.match(index, /ctx\.effect\(\(\) => ctx\.locale\.register\(QR_NS, \{ zh: qrZh, en: qrEn \}\)/)
  assert.match(index, /'settings\.oac\.quoteReply': QuoteReplyLocaleKey/)
})

test('quote reply registers the oac-quote reference source inside an effect, with the trigger service injected', async () => {
  const index = await read('src/client/index.ts')
  // The source rides the trigger pipeline service; the inject list awaits it,
  // so a kernel line without it hides the feature instead of throwing.
  assert.match(index, /import type \{\} from '@deepseek-ai\/dsh-client-ui-input-trigger\/client'/)
  assert.match(index, /import \{ QUOTE_REPLY_SOURCE \} from '\.\/quote-reply-source\.ts'/)
  assert.match(index, /ctx\.inject\(\['slots', 'conversation', 'sessions', 'inputTriggers'\]/)
  assert.match(index, /scope\.effect\(\(\) => scope\.inputTriggers\.registerSource\(QUOTE_REPLY_SOURCE\)/)
})

test('quote reply surfaces insert failures through the session-routed input face', async () => {
  const index = await read('src/client/index.ts')
  // The notice channel is the kernel's public session input face, addressed
  // through the session scope and resolved lazily per call.
  assert.match(index, /scope\.sessions\.scope\(sessionId as Parameters<typeof scope\.sessions\.scope>\[0\]\)/)
  assert.match(index, /const input = actx\?\.get\('conversation'\)\?\.input/)
  assert.match(index, /input\.for\(actx\)\.notify\(level, text\)/)
  // The chip insert rides the same facade: a span-CAS'd reference insertion
  // with a boolean answer the caller can retry on.
  assert.match(index, /return input\.for\(actx\)\.insertReference\(insert, span\)/)
  // Degradation: a missing scope/input face yields a no-op / false, never a throw.
  assert.match(index, /if \(actx === undefined \|\| input === undefined\) return/)
  assert.match(index, /if \(actx === undefined \|\| input === undefined\) return false/)
})

test('feature detection: the component hides without the input action face and documents the guard', async () => {
  const component = await read(COMPONENT)
  assert.match(component, /Feature detection \(cross-kernel-line guard\)/)
  assert.match(component, /const insertTarget: QuoteInsertTarget<TokenSpan> \| undefined = asQuoteInsertTarget<TokenSpan>\(inputActions\)/)
  assert.match(component, /if \(insertTarget === undefined\) return null/)
})

test('insert path: the pick composes the block, encodes it into the ref, and inserts the chip with one retry; failure is never silent', async () => {
  const component = await read(COMPONENT)
  // The excerpt helper rides the same self-contained source module.
  assert.match(component, /buildQuoteReplyChipLabel,/)
  // The chip payload: the model text is the UNCHANGED block composition, the
  // ref is its self-contained encoding, the label is the short display form.
  assert.match(component, /const modelText = buildQuoteReplyBlock\(\{/)
  assert.match(component, /draftNonEmpty: draftRef\.current\.trim\(\) !== ''/)
  assert.match(component, /insertAtStart: span\.start === 0/)
  assert.match(component, /source: QUOTE_REPLY_SOURCE_NAME,/)
  assert.match(component, /ref: encodeQuoteReplyRef\(modelText\),/)
  // The visible label is an excerpt of the passage itself — never the ordinal.
  assert.match(component, /label: t\('chipLabelExcerpt'\)\.replace\(/)
  assert.match(component, /buildQuoteReplyChipLabel\(target\.text, t\('chipLabelFallback'\)\)/)
  assert.doesNotMatch(component, /label: t\('chipLabel'\)/)
  // The header is role-only: no ordinal is threaded into the block.
  assert.doesNotMatch(component, /position/)
  assert.match(component, /clipboardText: modelText,/)
  // Capture → insert with the shared retry discipline; a persistent refusal
  // surfaces through the session-routed notice, never silently.
  assert.match(component, /insertQuoteReferenceIntoDraft\(/)
  assert.match(component, /captureInsertion: \(\) => insertTarget\.captureInsertion\(\), insertReference/)
  assert.match(component, /if \(!outcome\.ok\) notify\('error', t\('insertFailed'\)\)/)
})

test('coexistence: the draft is only ever appended to — no draft-replacing verb, no plain-text insert path', async () => {
  const component = await read(COMPONENT)
  const logic = await read(LOGIC)
  // setDraft is the kernel's whole-draft replacement; this feature must never
  // touch it, so pre-existing text and reference chips survive the insert.
  assert.doesNotMatch(component, /setDraft/)
  assert.doesNotMatch(logic, /setDraft/)
  // The chip channel replaced the plain-text insert: no insertText call site
  // remains, and the chip rides insertReference instead.
  assert.doesNotMatch(component, /insertText\(/)
  assert.match(component, /insertReference/)
})

test('selection overlay: reads only transcript scopes, and empty selections produce nothing', async () => {
  const component = await read(COMPONENT)
  assert.match(component, /const TRANSCRIPT_SCROLL_SELECTOR = '\[data-conversation-scroll\]'/)
  assert.match(component, /const FLOW_ITEM_SELECTOR = '\[data-chat-flow-kind\]'/)
  assert.match(component, /const STREAMING_SELECTOR = '\[data-streaming\]'/)
  assert.match(component, /document\.addEventListener\('selectionchange', update\)/)
  // Guards: collapsed selection, blank text, and selections spanning two
  // flow items all resolve to nothing.
  assert.match(component, /selection === null \|\| selection\.rangeCount === 0 \|\| selection\.isCollapsed\) return undefined/)
  assert.match(component, /if \(range\.toString\(\)\.trim\(\) === ''\) return undefined/)
  assert.match(component, /elementOf\(range\.endContainer\)\?\.closest\(FLOW_ITEM_SELECTOR\) !== item\) return undefined/)
  // The streaming mark is read from the flow item at pick time.
  assert.match(component, /streaming: item\.querySelector\(STREAMING_SELECTOR\) !== null/)
})

test('selection pill: the portal action renders alone — the quote bar surface is gone', async () => {
  const component = await read(COMPONENT)
  assert.match(component, /createPortal\(/)
  assert.match(component, /className="oac-qr-pick"/)
  assert.match(component, /onMouseDown=\{\(event\) => \{ event\.preventDefault\(\) \}\}/)
  assert.match(component, /onClick=\{pick\}/)
  assert.match(component, /\{t\('action'\)\}/)
  // No bar JSX, no pending state, no retry/cancel handlers anywhere.
  assert.doesNotMatch(component, /oac-qr-bar/)
  assert.doesNotMatch(component, /pending/)
  assert.doesNotMatch(component, /setPending/)
  assert.doesNotMatch(component, /barTitle/)
  assert.doesNotMatch(component, /t\('cancel'\)/)
  assert.doesNotMatch(component, /t\('retry'\)/)
})

test('styles: the quote reply stylesheet is injected with the plugin styles, and the bar rules are deleted', async () => {
  const styles = await read('src/client/styles.ts')
  const index = await read('src/client/index.ts')
  assert.match(styles, /export const QUOTEREPLY_CSS = `/)
  assert.match(styles, /\.oac-qr-pick \{/)
  // The pill's hover background stays opaque (the live-verified fix).
  assert.match(styles, /\.oac-qr-pick:hover \{ background: var\(--dsw-alias-interactive-bg-hover-solid/)
  // Our chip's label is width-capped inside the composer (attribute-scoped, so
  // other chip sources keep their own styling).
  assert.match(styles, /\[data-composer-chip="oac-quote"\] \[class\*="_label"\] \{/)
  assert.match(styles, /max-width: 320px;/)
  assert.match(styles, /min-width: 0;/)
  assert.match(styles, /overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/)
  assert.doesNotMatch(styles, /\.oac-qr-bar/)
  assert.match(index, /QUOTEREPLY_CSS/)
})

test('client program: the shared logic module is part of the client tsconfig', async () => {
  const tsconfig = await read('tsconfig.client.json')
  assert.match(tsconfig, /"src\/quote-reply-logic\.ts"/)
})

function objectKeys(block) {
  return [...block.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1])
}

test('i18n: en and zh dictionaries stay in sync and carry the block templates', async () => {
  const text = await read('src/client/locale-quote-reply.ts')
  const en = text.slice(text.indexOf('export const qrEn = {'), text.indexOf('export const qrZh = {'))
  const zh = text.slice(text.indexOf('export const qrZh = {'), text.indexOf('export type QuoteReplyLocaleKey'))
  assert.deepEqual(objectKeys(en).sort(), objectKeys(zh).sort())
  // The namespace is exactly what the feature renders — no dead key survives.
  assert.deepEqual(objectKeys(en).sort(), [
    'action',
    'chipLabelExcerpt',
    'chipLabelFallback',
    'insertFailed',
    'roleBot',
    'roleUser',
    'source',
    'streamingMark',
    'truncatedNote',
  ])
  for (const key of objectKeys(en)) {
    // Both dictionaries define a non-empty value for every key.
    assert.match(en, new RegExp(`\\n  ${key}: '.+'`), `en ${key}`)
    assert.match(zh, new RegExp(`\\n  ${key}: '.+'`), `zh ${key}`)
  }
  // The block header template is role-only (role + streaming mark); the
  // truncation note carries the omitted count; the chip label the excerpt.
  for (const block of [en, zh]) {
    assert.match(block, /source: '[^']*\{role\}[^']*\{streaming\}[^']*'/)
    assert.doesNotMatch(block, /\{position\}/)
    assert.doesNotMatch(block, /第\s*\{?position/)
    assert.match(block, /truncatedNote: '[^']*\{omitted\}[^']*'/)
    assert.match(block, /chipLabelExcerpt: '[^']*\{excerpt\}[^']*'/)
    assert.match(block, /chipLabelFallback: '.+'/)
    // The ordinal label is gone from the insertion path.
    assert.doesNotMatch(block, /\bchipLabel:/)
  }
  assert.match(en, /source: 'Quoted \{role\} message\{streaming\}:'/)
  assert.match(zh, /source: '引用\{role\}消息\{streaming\}：'/)
  assert.match(en, /action: 'Quote this passage'/)
  assert.match(zh, /action: '引用此段'/)
  assert.match(en, /chipLabelExcerpt: '“\{excerpt\}”'/)
  assert.match(zh, /chipLabelExcerpt: '「\{excerpt\}」'/)
  // The assistant side reads "bot" in the header: the key name matches its
  // value, and the old "assistant"/"助手" noun is gone from the vocabulary.
  assert.match(en, /roleBot: 'bot'/)
  assert.match(zh, /roleBot: 'bot'/)
  assert.doesNotMatch(en, /roleAssistant/)
  assert.doesNotMatch(zh, /roleAssistant/)
  assert.match(zh, /streamingMark: ' · 该条仍在生成中'/)
  assert.match(en, /insertFailed: 'The draft changed — please try again\.'/)
  assert.match(zh, /insertFailed: '草稿已变，请重试'/)
})

// The owner's decision, pinned at the source-read layer: the counting scheme
// (role-bearing flow-item ordinals) is removed end to end, so nothing in the
// feature can compute or carry a message number again.
test('ordinal removal: no position plumbing survives in the component or the shared logic', async () => {
  const component = await read(COMPONENT)
  const logic = await read(LOGIC)
  for (const [name, source] of [['component', component], ['logic', logic]]) {
    assert.doesNotMatch(source, /position/, `${name} carries no position plumbing`)
    assert.doesNotMatch(source, /quoteReplyPositionOf/, `${name} carries no ordinal helper`)
  }
  // The selection reader no longer collects the sibling flow kinds it only
  // needed in order to count messages.
  assert.doesNotMatch(component, /querySelectorAll\(FLOW_ITEM_SELECTOR\)/)
  assert.doesNotMatch(component, /ownIndex|\bkinds:/)
  // It still proves the selection sits in the resident transcript scrollport.
  assert.match(component, /item\.closest\(TRANSCRIPT_SCROLL_SELECTOR\) === null\) return undefined/)
})

test('i18n: no hardcoded copy in the feature sources', async () => {
  const component = await read(COMPONENT)
  const logic = await read(LOGIC)
  const locale = await read('src/client/locale-quote-reply.ts')
  // UI copy lives in the dictionaries; the feature sources stay English-only
  // comments/code with no literal CJK.
  assert.doesNotMatch(component, /[\u4e00-\u9fff]/)
  assert.doesNotMatch(logic, /[\u4e00-\u9fff]/)
  // The vocabulary the block composes from is imported from the dictionary
  // namespace, key by key; the chip label comes from the same namespace.
  for (const key of ['source', 'roleUser', 'roleBot', 'streamingMark', 'truncatedNote', 'chipLabelExcerpt', 'chipLabelFallback']) {
    assert.match(component, new RegExp(`t\\('${key}'\\)`), `t('${key}')`)
  }
  assert.ok(locale.includes('export type QuoteReplyLocaleKey'))
})
