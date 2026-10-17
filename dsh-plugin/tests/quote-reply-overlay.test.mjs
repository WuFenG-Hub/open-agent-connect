/**
 * Selection-driven quote reply — client wiring and dictionary checks.
 *
 * The runtime behaviour of the pure logic lives in quote-reply-logic.test.mjs;
 * this file pins the wiring a source read can prove: the slot/registration
 * shape, the feature-detection guards, the capture/insert/retry call sites,
 * the transcript DOM markers, and en/zh dictionary parity (which the typed
 * locale registration also enforces at compile time).
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

test('quote reply registers one additive conversation.input.overlay entry, gated by the slot declaration', async () => {
  const index = await read('src/client/index.ts')
  assert.match(index, /import \{ QuoteReplyOverlay, type QuoteReplyInjected \} from '\.\/QuoteReplyOverlay\.tsx'/)
  // The feature waits for the kernel's declaration: slots.inject only runs
  // its callback while the slot exists, so a kernel line without the overlay
  // slot gets no registration at all.
  assert.match(index, /scope\.slots\.inject\('conversation\.input\.overlay', \(\) => scope\.slots\.register\(\{/)
  assert.match(index, /name: 'conversation\.input\.overlay',\n\s+id: 'oac-quote-reply',\n\s+order: 30,/)
  assert.match(index, /locale: QR_NS,/)
  assert.match(index, /ctx\.effect\(\(\) => ctx\.locale\.register\(QR_NS, \{ zh: qrZh, en: qrEn \}\)/)
  assert.match(index, /'settings\.oac\.quoteReply': QuoteReplyLocaleKey/)
})

test('quote reply surfaces insert failures through the session-routed input face', async () => {
  const index = await read('src/client/index.ts')
  // The notice channel is the kernel's public session input face, addressed
  // through the session scope and resolved lazily per call.
  assert.match(index, /scope\.sessions\.scope\(sessionId as Parameters<typeof scope\.sessions\.scope>\[0\]\)/)
  assert.match(index, /const input = actx\?\.get\('conversation'\)\?\.input/)
  assert.match(index, /input\.for\(actx\)\.notify\(level, text\)/)
  // Degradation: a missing scope/input face yields a no-op, never a throw.
  assert.match(index, /if \(actx === undefined \|\| input === undefined\) return/)
})

test('feature detection: the component hides without the input action face and documents the guard', async () => {
  const component = await read(COMPONENT)
  assert.match(component, /Feature detection \(cross-kernel-line guard\)/)
  assert.match(component, /const insertTarget: QuoteInsertTarget<TokenSpan> \| undefined = asQuoteInsertTarget<TokenSpan>\(inputActions\)/)
  assert.match(component, /if \(insertTarget === undefined\) return null/)
})

test('insert path: capture/insert/retry goes through the shared helper; failure is never silent', async () => {
  const component = await read(COMPONENT)
  assert.match(component, /insertQuoteIntoDraft\(insertTarget, \(span\) =>/)
  assert.match(component, /if \(!outcome\.ok\) notify\('error', t\('insertFailed'\)\)/)
  // The bar keeps the failed pick visible with an explicit retry affordance.
  assert.match(component, /\{t\('retry'\)\}/)
})

test('coexistence: the draft is only ever appended to — no draft-replacing verb anywhere', async () => {
  const component = await read(COMPONENT)
  const logic = await read(LOGIC)
  // setDraft is the kernel's whole-draft replacement; this feature must never
  // touch it, so pre-existing text and reference chips survive the insert.
  assert.doesNotMatch(component, /setDraft/)
  assert.doesNotMatch(logic, /setDraft/)
  assert.doesNotMatch(component, /insertReference/)
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

test('quote bar: preview plus cancel render in the overlay slot, beside the portal action', async () => {
  const component = await read(COMPONENT)
  assert.match(component, /createPortal\(/)
  assert.match(component, /className="oac-qr-pick"/)
  assert.match(component, /onMouseDown=\{\(event\) => \{ event\.preventDefault\(\) \}\}/)
  assert.match(component, /className="oac-qr-bar"/)
  assert.match(component, /aria-label=\{t\('barTitle'\)\}/)
  assert.match(component, /\{pending\.preview\}/)
  assert.match(component, /\{t\('cancel'\)\}/)
})

test('styles: the quote reply stylesheet is injected with the plugin styles', async () => {
  const styles = await read('src/client/styles.ts')
  const index = await read('src/client/index.ts')
  assert.match(styles, /export const QUOTEREPLY_CSS = `/)
  assert.match(styles, /\.oac-qr-bar \{/)
  assert.match(styles, /\.oac-qr-pick \{/)
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
  assert.ok(objectKeys(en).length >= 10, 'the namespace carries every key the feature renders')
  for (const key of objectKeys(en)) {
    // Both dictionaries define a non-empty value for every key.
    assert.match(en, new RegExp(`\\n  ${key}: '.+'`), `en ${key}`)
    assert.match(zh, new RegExp(`\\n  ${key}: '.+'`), `zh ${key}`)
  }
  // The block header template carries role/position/streaming; the truncation
  // note carries the omitted count.
  for (const block of [en, zh]) {
    assert.match(block, /source: '[^']*\{role\}[^']*\{position\}[^']*\{streaming\}[^']*'/)
    assert.match(block, /truncatedNote: '[^']*\{omitted\}[^']*'/)
  }
  assert.match(en, /action: 'Quote this passage'/)
  assert.match(zh, /action: '引用此段'/)
  assert.match(zh, /streamingMark: ' · 该条仍在生成中'/)
  assert.match(en, /insertFailed: 'The draft changed — please try again\.'/)
  assert.match(zh, /insertFailed: '草稿已变，请重试'/)
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
  // namespace, key by key.
  for (const key of ['source', 'roleUser', 'roleAssistant', 'streamingMark', 'truncatedNote']) {
    assert.match(component, new RegExp(`t\\('${key}'\\)`), `t('${key}')`)
  }
  assert.ok(locale.includes('export type QuoteReplyLocaleKey'))
})
