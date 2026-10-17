/**
 * Selection-driven quote reply for the DSH transcript.
 *
 * The kernel owns the composer draft (and its @file/@session reference
 * chips), and offers no message-level action slots — so this feature is
 * selection-driven: a non-empty text selection inside a transcript message
 * floats one "quote this passage" action; picking it APPENDS a blockquoted
 * source header (role + position, with the in-generation mark when the source
 * is still streaming) plus a capped excerpt into the kernel draft through the
 * public input action face (`captureInsertion` / `insertText`). The kernel's
 * own chips and text are never replaced, only appended to.
 *
 * The component registers into `conversation.input.overlay` (the floating
 * composer layer) and renders two surfaces from there: the in-place quote bar
 * and, through a portal at the document body, the selection-anchored action.
 * It reads transcript facts from the kernel's own DOM markers
 * (`data-conversation-scroll` scrollport, `data-chat-flow-kind` flow items,
 * `data-streaming` live-generation marker) with pure resolution logic in
 * `quote-reply-logic.ts`.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  asQuoteInsertTarget,
  buildQuoteReplyBlock,
  insertQuoteIntoDraft,
  resolveQuoteReplyTarget,
  summarizeQuoteReplyExcerpt,
  type QuoteInsertTarget,
  type QuoteReplyLabels,
  type QuoteReplyTarget,
} from '../quote-reply-logic.ts'

/** Injected face of the overlay entry (business share; see the registration). */
export interface QuoteReplyInjected {
  /**
   * Session-routed composer notice (`SessionInput.notify`), resolved through
   * `ctx.conversation.input.for(actx)`. Degraded to a no-op when the session
   * input face is unavailable; the bar still shows the failure inline.
   */
  notify: (level: 'info' | 'error', text: string) => void
}

export type QuoteReplyOverlayProps =
  PropsRuntime<'conversation.input.overlay'>
  & PropsLocale<'settings.oac.quoteReply'>
  & InjectFace<QuoteReplyInjected>

/** Transcript scrollport marker the conversation layer puts on the resident body. */
const TRANSCRIPT_SCROLL_SELECTOR = '[data-conversation-scroll]'
/** One rendered transcript item; its attribute value is the chat node kind. */
const FLOW_ITEM_SELECTOR = '[data-chat-flow-kind]'
/** Live-generation marker the chat view puts on running output. */
const STREAMING_SELECTOR = '[data-streaming]'
/** Approximate action size, used only to clamp the anchor into the window. */
const ACTION_WIDTH = 132
const ACTION_HEIGHT = 30
const ACTION_MARGIN = 8

interface PendingQuote {
  /** Pick frozen at click time (streaming excerpt included, by design). */
  target: QuoteReplyTarget
  /** One-line bar preview. */
  preview: string
  /** Both insert attempts were refused — the bar shows the failure + retry. */
  failed: boolean
}

interface SelectionAnchor {
  left: number
  top: number
}

interface SelectionKey {
  start: Node
  startOffset: number
  end: Node
  endOffset: number
}

interface TranscriptSelection {
  key: SelectionKey
  range: Range
  target: QuoteReplyTarget
}

function elementOf(node: Node | null): Element | null {
  if (node === null) return null
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

function sameSelectionKey(a: SelectionKey | null, b: SelectionKey | null): boolean {
  if (a === null || b === null) return a === b
  return a.start === b.start && a.startOffset === b.startOffset && a.end === b.end && a.endOffset === b.endOffset
}

/**
 * Read the current document selection as a transcript pick. Empty or
 * collapsed selections, selections outside a transcript message, and
 * selections spanning two items all resolve to nothing (no action appears).
 * The composer's own input never matches: it has no `[data-chat-flow-kind]`
 * ancestor, and both ends must sit inside the SAME flow item of the resident
 * transcript scrollport.
 */
function resolveTranscriptSelection(): TranscriptSelection | undefined {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined
  const range = selection.getRangeAt(0)
  if (range.toString().trim() === '') return undefined
  const item = elementOf(range.startContainer)?.closest(FLOW_ITEM_SELECTOR) ?? null
  if (item === null || elementOf(range.endContainer)?.closest(FLOW_ITEM_SELECTOR) !== item) return undefined
  const scrollport = item.closest(TRANSCRIPT_SCROLL_SELECTOR)
  if (scrollport === null) return undefined
  const items = Array.from(scrollport.querySelectorAll(FLOW_ITEM_SELECTOR))
  const target = resolveQuoteReplyTarget({
    kind: item.getAttribute('data-chat-flow-kind') ?? undefined,
    kinds: items.map((entry) => entry.getAttribute('data-chat-flow-kind') ?? ''),
    ownIndex: items.indexOf(item),
    text: range.toString(),
    streaming: item.querySelector(STREAMING_SELECTOR) !== null,
  })
  if (target === undefined) return undefined
  return {
    key: {
      start: range.startContainer,
      startOffset: range.startOffset,
      end: range.endContainer,
      endOffset: range.endOffset,
    },
    range,
    target,
  }
}

/** Viewport anchor for the floating action, clamped into the window. */
function anchorOf(range: Range): SelectionAnchor {
  const rect = range.getBoundingClientRect()
  const left = Math.min(Math.max(rect.left, ACTION_MARGIN), Math.max(ACTION_MARGIN, window.innerWidth - ACTION_WIDTH - ACTION_MARGIN))
  const top = Math.min(rect.bottom + 6, Math.max(ACTION_MARGIN, window.innerHeight - ACTION_HEIGHT - ACTION_MARGIN))
  return { left, top }
}

export function QuoteReplyOverlay({ inputActions, useInput, t, notify }: QuoteReplyOverlayProps): ReactNode {
  // Feature detection (cross-kernel-line guard): the input action face is the
  // ONLY route to the kernel-owned draft. `conversation.input.overlay` types
  // the face as always present, but another kernel line may not hand it to
  // this slot's occupants — when the probe fails, the whole feature hides
  // (no error, no half-dead UI). The slot itself is already gated: the
  // registration rides `ctx.slots.inject`, which only runs while the kernel
  // declares the slot.
  const insertTarget: QuoteInsertTarget<TokenSpan> | undefined = asQuoteInsertTarget<TokenSpan>(inputActions)
  const draft = useInput((state) => state.draft)
  const [pending, setPending] = useState<PendingQuote | null>(null)
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)
  const selectionRef = useRef<TranscriptSelection | null>(null)
  const lastKeyRef = useRef<SelectionKey | null>(null)
  const dismissedRef = useRef(false)
  const draftRef = useRef('')
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    if (insertTarget === undefined) return undefined
    let frame = 0
    const update = (): void => {
      const selection = resolveTranscriptSelection()
      if (selection === undefined) {
        selectionRef.current = null
        lastKeyRef.current = null
        dismissedRef.current = false
        setAnchor(null)
        return
      }
      if (!sameSelectionKey(selection.key, lastKeyRef.current)) {
        lastKeyRef.current = selection.key
        // A NEW selection re-arms the action even right after a pick.
        dismissedRef.current = false
      }
      selectionRef.current = selection
      setAnchor(dismissedRef.current ? null : anchorOf(selection.range))
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }
    document.addEventListener('selectionchange', update)
    // The anchor is viewport-fixed: scrolling (any scrollport) and resizing
    // move the selection rect, so re-anchor instead of drifting.
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    update()
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [insertTarget])

  const insertBlock = useCallback((target: QuoteReplyTarget): boolean => {
    if (insertTarget === undefined) return false
    const labels: QuoteReplyLabels = {
      source: t('source'),
      roleUser: t('roleUser'),
      roleAssistant: t('roleAssistant'),
      streamingMark: t('streamingMark'),
      truncatedNote: t('truncatedNote'),
    }
    const outcome = insertQuoteIntoDraft(insertTarget, (span) =>
      buildQuoteReplyBlock({
        role: target.role,
        position: target.position,
        text: target.text,
        streaming: target.streaming,
        // Boundary facts stay in their own coordinate spaces: the insertion
        // point comes from the captured span, the emptiness question from the
        // published draft projection (chips expand differently per
        // projection, so the two must never be mixed).
        draftNonEmpty: draftRef.current.trim() !== '',
        insertAtStart: span.start === 0,
      }, labels))
    if (!outcome.ok) notify('error', t('insertFailed'))
    return outcome.ok
  }, [insertTarget, notify, t])

  const pick = useCallback((): void => {
    const selection = selectionRef.current
    if (selection === null || insertTarget === undefined) return
    // The pick is frozen here: the excerpt (and the streaming mark) reflect
    // the selection as it was at click time, even if the message keeps
    // streaming afterwards.
    const ok = insertBlock(selection.target)
    dismissedRef.current = true
    setAnchor(null)
    setPending({ target: selection.target, preview: summarizeQuoteReplyExcerpt(selection.target.text), failed: !ok })
  }, [insertBlock, insertTarget])

  if (insertTarget === undefined) return null

  const action = anchor === null ? null : createPortal(
    <div className="oac-qr-float" style={{ left: anchor.left, top: anchor.top }}>
      <button
        type="button"
        className="oac-qr-pick"
        // Keep the selection alive until the click commits the pick.
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={pick}
      >
        {t('action')}
      </button>
    </div>,
    document.body,
  )

  const bar = pending === null ? null : (
    <div className="oac-qr-bar" role="group" aria-label={t('barTitle')}>
      <span className="oac-qr-bar-title">{t('barTitle')}</span>
      <span className="oac-qr-bar-preview" title={pending.preview}>{pending.preview}</span>
      {pending.failed
        ? <span className="oac-qr-bar-error">{t('insertFailed')}</span>
        : null}
      {pending.failed
        ? (
          <button
            type="button"
            className="oac-qr-bar-action"
            onClick={() => {
              const ok = insertBlock(pending.target)
              setPending({ target: pending.target, preview: pending.preview, failed: !ok })
            }}
          >
            {t('retry')}
          </button>
        )
        : null}
      <button type="button" className="oac-qr-bar-action" onClick={() => { setPending(null) }}>
        {t('cancel')}
      </button>
    </div>
  )

  return (
    <>
      {action}
      {bar}
    </>
  )
}
