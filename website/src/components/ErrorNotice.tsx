import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react'

import AskAgentButton from './AskAgentButton'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import type { ErrorReport } from '../utils/errorReport'

import { i18nT } from '../i18n/t'

/**
 * The shared error surface — one place that renders an error *and* offers to
 * hand it to the agent.
 *
 * Replaces the ad-hoc `{err && <div className="text-danger">{err}</div>}` shape
 * repeated across the dashboard. The migration is deliberately trivial: pass the
 * same string the call site already had and the structured context (endpoint,
 * status, backend `code`) is recovered from the error journal
 * (`utils/errorReport`), so no call site has to start threading an error object.
 *
 * Pass `report` instead when the caller genuinely holds one (a caught
 * `ApiError`), which skips the message-match lookup.
 *
 * ## Two variants, because the dashboard has two shapes
 *
 * `block` is the boxed banner at the top of a panel. `inline` is the compact
 * run of text that sits inside an existing button row — those sites are laid out
 * as flex children, so dropping a bordered box into one would break the row. The
 * variant is a layout choice only; both carry the same agent hand-off.
 */
export default function ErrorNotice({
  message,
  report,
  title,
  onDismiss,
  variant = 'block',
  askAgent = false,
  onHandoff,
  className = '',
  messageClassName = '',
  testId,
}: {
  /** Human error text. Falsy renders nothing, so `<ErrorNotice message={err} />` needs no `&&` guard. */
  message?: string | null
  /** Structured report, when known. Otherwise looked up by `message`. */
  report?: ErrorReport
  /**
   * Optional bold lead ("Save failed"). Kept separate from `message` rather than
   * concatenated, because `message` is the journal lookup key — prefixing it
   * would lose the structured context this component exists to recover.
   */
  title?: string
  /** Renders a dismiss affordance when provided. */
  onDismiss?: () => void
  /** `block` = boxed banner; `inline` = compact text for an existing flex row. */
  variant?: 'block' | 'inline'
  /**
   * Opt IN to the agent hand-off. **Defaults to `false`, and the direction of that
   * default is the safety property.**
   *
   * The hand-off navigates to the chat, which unmounts whatever rendered this
   * banner. Any value still living in that subtree's local state is destroyed —
   * and a save banner is, by definition, showing because the value was NOT
   * persisted. So an opt-OUT default makes *forgetting a prop* mean silent data
   * loss, on exactly the surfaces most likely to have a half-filled form. Opt-in
   * inverts that: forgetting the prop means "no button", which costs a
   * convenience and loses nothing.
   *
   * Set it `true` where there is nothing to lose — crash fallbacks, and read/list
   * failures on pages that hold no draft input. Leave it off next to any editable
   * field whose contents are not yet saved somewhere durable.
   */
  askAgent?: boolean
  /**
   * Forwarded to the hand-off button: runs only once the hand-off has actually
   * proceeded. For a notice rendered inside an OVERLAY that would otherwise sit
   * over the chat the hand-off navigates to (a modal, the remote-crew error
   * panel), so the caller can dismiss it — a hand-off the user cannot see reads
   * as a dead button. Ignored when `askAgent` is off.
   */
  onHandoff?: () => void
  className?: string
  /**
   * Classes for the `message` span only — e.g. `font-mono` when the message is
   * verbatim tool or server output. Scoped there, not on the root, so a
   * plain-language `title` keeps the UI font and reads as a separate clause
   * from the raw output beside it.
   *
   * A `line-clamp-*` here also opts the inline variant into recovering the text
   * the clamp hides, but only once measurement confirms the text really is
   * clipped. The message then renders as a real `<button>` — marked with a dotted
   * underline and a help cursor, carrying the full message as its `title` and
   * `aria-expanded` for the popover state — so the disclosure has genuine button
   * semantics rather than a tab stop bolted onto a span. Focus AND click both open
   * it, so the reveal never rests on whether a given browser gives a tapped
   * element focus; Enter and Space come free from the button. It sits in the
   * message region, NOT the action group, so it cannot become a third control in
   * a row that already holds two. Derived rather than a separate prop because the
   * clamp IS the condition; a caller that clips text always owes a way to read
   * the rest.
   */
  messageClassName?: string
  /**
   * `data-testid` for the root element. Several notices can share one surface
   * (a page-level read failure above a row's own mutation failure), and a
   * shared `role="alert"` makes a lookup ambiguous — a call site that migrates
   * an existing `<p data-testid="…">` keeps its id here.
   */
  testId?: string
}) {
  // Before the `!message` bail, which would otherwise make this conditional.
  const [tailOpen, setTailOpen] = useState(false)
  // In state, not a ref: the element TYPE changes with `clipped`, so a ref would
  // leave the observer on the detached node, which reports 0 and flips it back off.
  const [msgEl, setMsgEl] = useState<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const tailId = useId()
  // The clamp class says the caller WANTS clipping; only measurement says the text
  // IS clipped — a disclosure over text that already fits promises nothing.
  const [clipped, setClipped] = useState(false)
  const clamps = /line-clamp/.test(messageClassName)

  useEffect(() => {
    const el = msgEl
    if (!clamps || !el) {
      setClipped(false)
      return
    }
    const measure = () => {
      if (!el.isConnected) return
      setClipped(el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [clamps, message, messageClassName, msgEl])

  /**
   * Closes the reveal on blur, EXCEPT when focus lands inside the popover: a
   * mousedown there is a drag to select the text, and closing mid-drag is why the
   * error could not be copied. Radix still handles outside-click and Escape.
   */
  function handleMessageBlur(e: FocusEvent<HTMLElement>) {
    const next = e.relatedTarget as Node | null
    if (next && contentRef.current?.contains(next)) return
    setTailOpen(false)
  }

  if (!message) return null

  if (variant === 'inline') {
    return (
      <span role="alert" className={`inline-flex items-center gap-1.5 text-[12px] text-danger ${className}`} data-testid={testId}>
        {/* Two regions, deliberately: the disclosure below is an affordance of the
            message, so it must not join the action group and make a third control
            in a row already holding Ask-the-agent and Retry. */}
        <span className="min-w-0 inline-flex items-center gap-1.5">
          <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
          {title && <strong className="font-semibold">{title}</strong>}
          {clamps ? (
            // Portaled, not an in-row reveal: the tab bar's row is a fixed `h-8`
            // that an expanding message would overflow.
            <Popover open={tailOpen && clipped} onOpenChange={setTailOpen}>
              <PopoverAnchor asChild>
                {clipped ? (
                  <button
                    ref={setMsgEl}
                    type="button"
                    aria-expanded={tailOpen}
                    aria-label={i18nT('components.errorNotice.show_full_message')}
                    aria-describedby={tailOpen ? tailId : undefined}
                    className={`min-w-0 text-left bg-transparent border-none p-0 font-inherit text-inherit cursor-help underline decoration-dotted underline-offset-2 ${messageClassName}`}
                    title={message}
                    onFocus={() => setTailOpen(true)}
                    onBlur={handleMessageBlur}
                    onClick={() => setTailOpen(true)}
                    style={{ overflowWrap: 'anywhere' }}
                  >{message}</button>
                ) : (
                  <span
                    ref={setMsgEl}
                    className={`min-w-0 ${messageClassName}`}
                    style={{ overflowWrap: 'anywhere' }}
                  >{message}</span>
                )}
              </PopoverAnchor>
              {clipped && (
                <PopoverContent
                  ref={contentRef}
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  id={tailId}
                  role="tooltip"
                  className="w-72 max-w-[80vw] p-2 text-[12px] leading-snug select-text"
                  style={{ overflowWrap: 'anywhere' }}
                  // The anchor is what the user is reading; moving focus here would
                  // blur it and close this again.
                  onOpenAutoFocus={e => e.preventDefault()}
                >{message}</PopoverContent>
              )}
            </Popover>
          ) : (
            <span className={`min-w-0 ${messageClassName}`} style={{ overflowWrap: 'anywhere' }}>{message}</span>
          )}
        </span>
        <span className="shrink-0 inline-flex items-center gap-1.5">
          {askAgent && (
            <AskAgentButton
              report={report}
              message={message}
              onHandoff={onHandoff}
            />
          )}
          {onDismiss && (
            <button
              type="button"
              className="shrink-0 bg-transparent border-none p-0 cursor-pointer text-danger/70 hover:text-danger transition-colors"
              aria-label={i18nT('components.errorNotice.dismiss')}
              onClick={onDismiss}
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </span>
      </span>
    )
  }

  return (
    <div
      role="alert"
      className={`rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 flex items-start gap-2 text-[13px] text-danger ${className}`}
      data-testid={testId}
    >
      <AlertTriangle size={14} className="mt-[2px] shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap" style={{ overflowWrap: 'anywhere' }}>
        {title && <strong className="font-semibold">{title} </strong>}
        {/* Wrapped only when asked: the bare text node is the shape every
            existing consumer's tests read. */}
        {messageClassName ? <span className={messageClassName}>{message}</span> : message}
      </div>
      {askAgent && (
        <AskAgentButton
          report={report}
          message={message}
          onHandoff={onHandoff}
          className="mt-[1px]"
        />
      )}
      {onDismiss && (
        <button
          type="button"
          className="shrink-0 bg-transparent border-none p-0 cursor-pointer text-danger/70 hover:text-danger transition-colors"
          aria-label={i18nT('components.errorNotice.dismiss')}
          onClick={onDismiss}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
