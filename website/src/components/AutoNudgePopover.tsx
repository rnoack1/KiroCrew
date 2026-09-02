import { useEffect, useMemo, useRef, useState } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Goal, X } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import ErrorNotice from './ErrorNotice'
import { api } from '../api/client'
import { runBelongsToSlot } from '../apps/workflows/runModel'
import { loadGoalDraft, saveGoalDraft, type GoalDraft } from '../utils/goalDrafts'
import { DRAFT_SAVE_DEBOUNCE_MS } from '../utils/draftConstants'

import { i18nT } from '../i18n/t'
import { fmtTimeNumeric } from '../i18n/format'
import { type AutoNudgeLoop, cycleText as loopCycleText, nextCycleText } from './autoNudgeLoop'
export type { AutoNudgeLoop } from './autoNudgeLoop'

interface Props {
  slotKey: string
  loop: AutoNudgeLoop | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (loop: AutoNudgeLoop | null) => void
  /**
   * True when the slot's last turn ended interrupted (the composer is showing
   * Resume). The chip stops pulsing and turns warn-coloured: the loop is still
   * armed, but nothing is running until the user resumes or the next idle-timer
   * cycle fires, and a pulsing chip would claim active work for that whole gap.
   */
  interrupted?: boolean
}

const DEFAULT_MSG = `Your north star is in north_star.md, roadmap in roadmap.md, tasks in tasks.md. Pick the single highest-leverage next step toward the goal and execute it. Update tasks.md. Post a blocker ONCE if genuinely stuck. To halt the loop, create {{STOP_FILE}}`

/** One armed script cron owned by this chat slot. */
interface SlotWatch {
  id: string
  name: string
  schedule: string
  next_run_ts: number | null
}

export default function AutoNudgePopover({ slotKey, loop, open, onOpenChange, onChange, interrupted = false }: Props) {
  // `||` (not `??`) is deliberate on the loop tier: it preserves the fallback
  // so a loop with idle_secs/max_cycles of 0 or an empty message still shows
  // the 60 / 0 / default template rather than a bare 0 / "".
  const [message, setMessage] = useState(() => loop?.message || DEFAULT_MSG)
  // Idle-seconds and max-cycles are held as RAW STRINGS while the popover is
  // open so every edit (including a fully-cleared field or a transient "") is
  // allowed as-typed. Coercing to a number on each keystroke would snap a
  // backspaced-to-empty field straight back to its default and prevent removing
  // the leading digit. The string is parsed
  // into a number only when the field commits (blur / save); an empty or
  // unparseable value falls back to the field default — 60 idle, 0 cycles.
  const [idleInput, setIdleInput] = useState(() => String(loop?.idle_secs || 60))
  const [maxCyclesInput, setMaxCyclesInput] = useState(() => String(loop?.max_cycles || 0))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // `ignored` is the server declining the submitted text; `kept` is the user declining to
  // overwrite. One state, not two booleans, since the two can never be true at once.
  const [saveNotice, setSaveNotice] = useState<'ignored' | 'kept' | null>(null)
  // Armed when Save would overwrite a REDACTED goal with the mask the user was shown.
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  // Render scope, not save-local: the confirm must disappear the moment the edit is
  // reverted, or a settings-only save carries a destructive "replace" label.
  // Whether the USER typed in the goal textarea this open. The goal patch is gated on
  // this, never on comparing against a `loop` a live update can replace underneath us.
  const goalEdited = useRef(false)
  // Latched at OPEN, because both inputs below are live: a websocket update replacing `loop`
  // with a newer clean goal must neither disarm the gate nor become its own baseline.
  const [redactedAtOpen, setRedactedAtOpen] = useState(false)
  const [servedAtOpen, setServedAtOpen] = useState<string | null>(null)
  // The goal the CONFIRM was armed on, latched when the gate appears. A render-time check
  // cannot close the race: the live goal can move between the read and the click.
  const [confirmArmedFor, setConfirmArmedFor] = useState<string | null>(null)
  // Re-arming is otherwise signalled ONLY by the preview text changing, which a screen
  // reader is never told, so the gate silently swallows the click that looked like a yes.
  const [confirmRearmed, setConfirmRearmed] = useState(false)
  // The BASELINE the confirm was armed on. Latched apart from the text above, which is a
  // redacted projection two different goals can share and so cannot identify one.
  const [confirmArmedFingerprint, setConfirmArmedFingerprint] = useState<string | null>(null)
  // Both arms require an actual edit: `save` gates the patch on `goalEdited.current`, so
  // arming without one promises a destruction that cannot happen.
  const editsRedactedGoal =
    goalEdited.current &&
    (Boolean(loop?.message_redacted) || redactedAtOpen) &&
    message !== (loop?.message ?? '')
  // The stored goal changed under an edit already in progress, so saving the typed text
  // would discard a goal this user never saw. Same irreversibility, same explicit act.
  const goalMovedUnderEdit =
    goalEdited.current && servedAtOpen !== null && (loop?.message ?? '') !== servedAtOpen
  const needsOverwriteConfirm = editsRedactedGoal || goalMovedUnderEdit
  const confirmBlocked = saving || !message.trim()
  // The confirm lives BELOW the action row, never in Save's position: swapping it in
  // where Save was let a double-click land on it, defeating the gate it exists to be.
  const confirmPending = confirmOverwrite && needsOverwriteConfirm
  const dismissRef = useRef<HTMLButtonElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Disabling Save drops focus to <body>, so land it on the arm that WRITES NOTHING -- the
  // keep-stored arm still PATCHes, so a habituated second Enter there commits a partial save.
  useEffect(() => {
    if (confirmPending) dismissRef.current?.focus()
  }, [confirmPending])
  // Watches armed on this slot, read through the SHARED `cron-jobs` query rather
  // than a private fetch. That key is invalidated by the websocket hook, so a
  // watch deleted or paused elsewhere disappears from an open popover instead of
  // lingering until it is reopened -- and the request dedupes with the other
  // consumer of the same key. `enabled: open` keeps a zero-token watch from
  // costing a request on every chat render just to say "still nothing".
  const { data: cronJobs, isError: watchesFailed, refetch: refetchWatches } = useQuery({
    queryKey: ['cron-jobs'],
    queryFn: () => api.crons().then(r => r.jobs || []),
    enabled: open,
  })

  const watches: SlotWatch[] = useMemo(() => {
    const rows: unknown[] = Array.isArray(cronJobs) ? cronJobs : []
    return rows
      .filter((j): j is Record<string, unknown> => !!j && typeof j === 'object')
      .filter(j => {
        // One ownership rule, one spelling. `runBelongsToSlot` already maps a
        // session_key onto a chat slot against the same backend convention
        // (`dashboard:<slotKey>`); a second inline predicate here would drift
        // from it the day that key format moves.
        if (!runBelongsToSlot(typeof j.session_key === 'string' ? j.session_key : '', slotKey)) {
          return false
        }
        // A watch is a SCRIPT cron: it runs a Python callable and never reaches a
        // model. A message-only cron on this slot is an ordinary reminder that
        // DOES wake the agent, so it does not belong under a heading that
        // promises zero tokens.
        return typeof j.script === 'string' && !!j.script && j.enabled !== false
      })
      .map(j => ({
        id: String(j.id ?? ''),
        name: String(j.name ?? ''),
        schedule: String(j.schedule ?? ''),
        next_run_ts: typeof j.next_run_ts === 'number' ? j.next_run_ts : null,
      }))
  }, [cronJobs, slotKey])

  const parseIdle = (s: string) => parseInt(s, 10) || 60
  const parseCycles = (s: string) => parseInt(s, 10) || 0

  // Only a genuine user edit should persist a draft. Seeding from the live loop
  // or restoring a remembered draft on open must NOT re-write the store (doing
  // so would reset the slot's TTL / LRU position on a mere view, and could
  // mirror a live loop's config into the user-draft store). `hasEdited` gates
  // the persist so it fires on real onChange edits only.
  const hasEdited = useRef(false)
  // Latest field values, kept current every render so the close-flush below
  // (which runs from a stable handler) can read them.
  const latest = useRef({ slotKey, message, idleInput, maxCyclesInput, loop })
  latest.current = { slotKey, message, idleInput, maxCyclesInput, loop }

  // Compute the draft to persist for the current field state, or null to drop
  // the slot: the blank / pristine-default case stores nothing so an emptied or
  // untouched popover never pins the template. (Only reached when no loop is
  // running — a live loop is authoritative and its config is never mirrored
  // into the user-draft store; persistence is skipped entirely while a loop is
  // present.)
  function draftToPersist(s: typeof latest.current): GoalDraft | null {
    const idleSecs = parseIdle(s.idleInput)
    const maxCycles = parseCycles(s.maxCyclesInput)
    const isPristineDefault = s.message === DEFAULT_MSG && idleSecs === 60 && maxCycles === 0
    return isPristineDefault ? null : { message: s.message, idleSecs, maxCycles }
  }

  // Seed/restore fields on each open (rising edge). A live loop is the
  // authoritative source; otherwise the last per-slot draft is restored.
  // One read seeds all three fields. Runs in an effect (not render) so the
  // render itself performs no storage read/write.
  useEffect(() => {
    if (!open) return
    hasEdited.current = false
    goalEdited.current = false
    // Latched HERE, at open, not at the first keystroke: a live update landing between the
    // render and that keystroke would otherwise become its own baseline and pass unnoticed.
    setRedactedAtOpen(Boolean(loop?.message_redacted))
    setServedAtOpen(loop?.message ?? '')
    setError('')
    // Reset the transient save state too: an armed confirmation surviving a dismiss
    // would let the next Save overwrite a redacted goal with no fresh confirmation.
    setConfirmOverwrite(false)
    setSaveNotice(null)
    if (loop) {
      // `||` (not `??`) is deliberate: a loop with idle_secs/max_cycles of 0
      // or an empty message shows the 60 / 0 / default template.
      setMessage(loop.message || DEFAULT_MSG)
      setIdleInput(String(loop.idle_secs || 60))
      setMaxCyclesInput(String(loop.max_cycles || 0))
    } else {
      const remembered = loadGoalDraft(slotKey)
      setMessage(remembered ? remembered.message : DEFAULT_MSG)
      setIdleInput(String(remembered ? remembered.idleSecs : 60))
      setMaxCyclesInput(String(remembered ? remembered.maxCycles : 0))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge seed only; loop/slotKey are read fresh each open
  }, [open])

  // Flush a pending debounced edit synchronously when the popover closes OR
  // unmounts while open, so edits within the last DRAFT_SAVE_DEBOUNCE_MS
  // window aren't lost. Effect cleanup covers both paths.
  useEffect(() => {
    if (!open) return
    return () => {
      if (!hasEdited.current || latest.current.loop) return
      saveGoalDraft(latest.current.slotKey, draftToPersist(latest.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable cleanup reading the latest ref
  }, [open])

  // Persist edits per slot, debounced with the same DRAFT_SAVE_DEBOUNCE_MS as
  // chat drafts so a long goal doesn't drive a synchronous localStorage write on
  // every keystroke. Skips until the user actually edits a field (so opening the
  // popover or the open-restore setState above never writes).
  useEffect(() => {
    if (!open || !hasEdited.current || loop) return
    const timer = setTimeout(() => saveGoalDraft(slotKey, draftToPersist(latest.current)), DRAFT_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `draftToPersist` is a pure transform of the ref snapshot it is handed, redeclared each render, so its identity carries no information the deps above miss. Depending on it would restart the debounce timer on every unrelated re-render — the coalescing this effect exists for.
  }, [open, slotKey, message, idleInput, maxCyclesInput, loop])

  async function save(opts?: { keepStoredGoal?: boolean }) {
    // ``=== true`` on purpose: a call site that forwards a DOM event as the first
    // argument must never enable this, only an explicit caller.
    const keepStoredGoal = opts?.keepStoredGoal === true
    // The overwrite is IRREVERSIBLE and the server cannot return the original, so an
    // edit to a redacted goal needs an explicit act, not passive copy the user skims.
    if (needsOverwriteConfirm && !confirmOverwrite && !keepStoredGoal) {
      setConfirmArmedFor(loop?.message ?? '')
      setConfirmArmedFingerprint(loop?.message_fingerprint ?? '')
      setConfirmOverwrite(true)
      return
    }
    // Past the gate, the stored goal must still be the one the confirm was armed on: a
    // click answering a question about text no longer there re-arms instead of committing.
    if (confirmOverwrite && !keepStoredGoal && (loop?.message ?? '') !== confirmArmedFor) {
      setConfirmArmedFor(loop?.message ?? '')
      setConfirmArmedFingerprint(loop?.message_fingerprint ?? '')
      setConfirmRearmed(true)
      return
    }
    setConfirmRearmed(false)
    setSaving(true)
    setError('')
    try {
      // Parse from the raw strings here (not a committed number state) so a value
      // typed and then Save-clicked without an intervening blur is still captured.
      const idle_secs = parseIdle(idleInput)
      const max_cycles = parseCycles(maxCyclesInput)
      const body = JSON.stringify({ slot_key: slotKey, message, idle_secs, max_cycles })
      // The GET that populated `loop.message` returns a SCRUBBED projection, so echoing
      // it back unconditionally would overwrite the stored message with its redaction.
      const patch: Record<string, unknown> = { idle_secs, max_cycles, active: true }
      if (loop && !keepStoredGoal && goalEdited.current && message !== (loop.message ?? '')) {
        patch.message = message
        // The baseline the confirm was ARMED on, never the live one, which carries the newer
        // goal's own token; read only while the gate is up so no latch outlives its confirm.
        const armed = confirmOverwrite ? confirmArmedFingerprint : null
        patch.expect_fingerprint = armed ?? loop.message_fingerprint ?? ''
      }
      const resp = loop
        ? await fetch(`/api/autonudge/${loop.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
        : await fetch('/api/autonudge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      const data = await resp.json()
      if (resp.status === 409) {
        // Not a failed save: the newer goal is intact and the user's view was stale.
        setConfirmOverwrite(false)
        setConfirmArmedFor(null)
        setConfirmArmedFingerprint(null)
        setError(data.error || `HTTP ${resp.status}`)
        return
      }
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
      // A 200 can still have kept the stored goal, so surface it and stay open rather
      // than reporting a save that did not fully happen.
      setConfirmOverwrite(false)
      if (data.message_ignored === true) {
        setSaveNotice('ignored')
        // The confirm button the user pressed unmounts with the gate, so focus would fall
        // to <body> here too; the notice below is announced via role="status".
        textareaRef.current?.focus()
        onChange(data.loop)
        return
      }
      onChange(data.loop)
      if (keepStoredGoal) {
        // NOT `ignored`: nothing was ignored, the user declined the overwrite, and that
        // notice would blame a text match and ask for the retry they just refused.
        setSaveNotice('kept')
        // The user is still editing: closing reseeds the textarea from the served
        // projection on reopen, and no draft covers it while a loop exists.
        textareaRef.current?.focus()
        return
      }
      setSaveNotice(null)
      onOpenChange(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function stop() {
    if (!loop) return
    setSaving(true)
    try {
      const resp = await fetch(`/api/autonudge/${loop.id}`, { method: 'DELETE' })
      if (!resp.ok) {
        // Parse JSON body for server-supplied error (e.g. 503 when feature disabled).
        // Only on error path: a successful DELETE may return 204 No Content.
        const data = await resp.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${resp.status}`)
      }
      onChange(null)
      onOpenChange(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // ── Countdown to the next trigger (#6482) ──
  // The 1s ticker runs only while the popover is OPEN (review finding: a
  // closed-but-armed loop must not re-render the toolbar button every second
  // all day). The hover affordance needs no ticker: a native title tooltip
  // snapshots at hover-start, so the trigger's onMouseEnter/onFocus refresh
  // nowTs once, which is exactly the freshness a tooltip glance can show.
  const ticking = open && !!loop?.active && (loop.next_due_ts || 0) > 0
  const [nowTs, setNowTs] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!ticking) return
    setNowTs(Date.now() / 1000)
    const timer = setInterval(() => setNowTs(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  const refreshNow = () => setNowTs(Date.now() / 1000)
  /** Hover/popover line for the next trigger, or '' when no active loop — the
   *  shared deadline-preserving reading (see `nextCycleText`). */
  const countdownText = nextCycleText(loop, nowTs)
  /** The tooltip only carries a REAL deadline signal (counting or due) — the
   *  "not yet scheduled" placeholder is popover-only, so an armed-but-unscheduled
   *  loop keeps the plain "Goal active (cycle N)" title. */
  const titleCountdown = loop?.active && (loop.next_due_ts || 0) > 0 ? countdownText : ''
  /** Cycle readout for the chip, tooltip and popover header ("3/24", or a
   *  bare "3" under an infinite cap). Interpolated as the {{cycle}} VALUE of
   *  the existing strings, so no catalogue text changes. Unlike the countdown
   *  this is safe in aria-label: it changes once per cycle, not once per
   *  second. */
  const cycleText = loopCycleText(loop)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={`h-8 px-2 rounded-lg text-[12px] font-mono flex items-center gap-1 cursor-pointer transition-all bg-transparent border-none shrink-0 whitespace-nowrap ${
            loop?.active
              ? interrupted
                ? 'text-warn hover:text-warn hover:bg-warn/10'
                : 'text-accent hover:text-accent hover:bg-accent/10 animate-pulse'
              : 'text-muted hover:text-text hover:bg-bg-hover'
          }`}
          title={loop?.active ? `${interrupted ? i18nT('components.autoNudgePopover.goal_interrupted_cycle', { cycle: cycleText }) : i18nT('components.autoNudgePopover.goal_active_cycle', { cycle: cycleText })}${titleCountdown ? ` · ${titleCountdown}` : ''}` : i18nT('components.autoNudgePopover.set_a_goal')}
          // The countdown stays OUT of aria-label (review finding): a
          // per-second label change re-announces the button to screen readers.
          aria-label={loop?.active ? (interrupted ? i18nT('components.autoNudgePopover.goal_interrupted_cycle', { cycle: cycleText }) : i18nT('components.autoNudgePopover.goal_active_cycle', { cycle: cycleText })) : i18nT('components.autoNudgePopover.set_a_goal')}
          onMouseEnter={refreshNow}
          onFocus={refreshNow}
        >
          <Goal size={16} className="shrink-0" />
          {loop?.active && loop.cycle_count > 0 ? cycleText : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[420px] max-w-[calc(100vw-2rem)] p-4 text-[12px]"
        onEscapeKeyDown={e => {
          // Escape is the habitual CANCEL, but closing the popover discards the typed
          // goal, which no draft covers while a loop exists. Cancel the gate instead.
          if (!confirmPending) return
          e.preventDefault()
          setConfirmOverwrite(false)
          textareaRef.current?.focus()
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 font-medium text-text">
            <Goal size={14} className={loop?.active ? 'text-accent' : 'text-muted'} />
            {i18nT('components.autoNudgePopover.set_a_goal')}
            {loop?.active && <span className="text-muted text-[11px]">{i18nT('components.autoNudgePopover.cycle')} {cycleText}</span>}
          </div>
          <button aria-label={i18nT('components.autoNudgePopover.close')} onClick={() => onOpenChange(false)} className="text-muted hover:text-text bg-transparent border-none cursor-pointer">
            <X size={14} />
          </button>
        </div>
        <p className="text-muted text-[11px] mb-3 leading-relaxed">{i18nT('components.autoNudgePopover.give_the_agent_a_goal_and_it_will_keep_working_t')}</p>

        {watchesFailed && (
          <div className="flex items-center justify-between gap-2 mb-3">
            {/* No hand-off: the popover holds the unsaved goal message, idle and max-cycle inputs.
                Retry is the recovery path, as on every sibling load-failure notice. */}
            <ErrorNotice
              variant="inline"
              testId="auto-nudge-watches-error"
              message={i18nT('components.autoNudgePopover.watches_load_failed')}
            />
            <button
              type="button"
              onClick={() => { void refetchWatches() }}
              className="px-2 py-0.5 rounded border border-border text-[11px] text-muted hover:text-text bg-transparent cursor-pointer shrink-0"
            >
              {i18nT('components.autoNudgePopover.retry')}
            </button>
          </div>
        )}

        {watches.length > 0 && (
          <div className="border border-border rounded p-2 mb-3">
            <div className="text-text text-[11px] font-medium mb-1">
              {i18nT('components.autoNudgePopover.watches_title')}
            </div>
            <ul className="list-none p-0 m-0 mb-1">
              {watches.map(w => (
                <li key={w.id} className="text-muted text-[11px] leading-relaxed">
                  <span className="text-text">{w.name}</span>
                  {w.schedule && <span> · {w.schedule}</span>}
                  {w.next_run_ts && (
                    <span> · {i18nT('components.autoNudgePopover.watches_next')} {fmtTimeNumeric(w.next_run_ts)}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="text-muted text-[11px] leading-relaxed">
              {i18nT('components.autoNudgePopover.watches_note')}
            </div>
          </div>
        )}

        <div className="text-muted text-[11px] mb-1">{i18nT('components.autoNudgePopover.goal_description')}</div>
        {loop?.message_redacted && (
          <div role="status" data-testid="autonudge-redacted-notice" className="text-warn text-[12px] font-medium mb-1">
            {/* One line per sentence, at body size: the irreversibility warning read as
                fine print and sat mid-paragraph where a skimming reader missed it. Split
                on the terminator so bn/hi danda works too, not on any locale's wording. */}
            {i18nT('components.autoNudgePopover.message_redacted_notice')
              .split(/(?<=[.।])\s+/)
              .filter(Boolean)
              .map((sentence, i) => (
                <div key={i} className={i === 0 ? '' : 'mt-1'}>
                  {sentence}
                </div>
              ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          aria-label={i18nT('components.autoNudgePopover.goal_description')}
          value={message}
          onChange={e => {
            hasEdited.current = true
            goalEdited.current = true
            // An armed confirmation answers the text it was armed FOR. Reverting to the
            // redacted copy and editing again reused it, overwriting with no second ask.
            setConfirmOverwrite(false)
            setSaveNotice(null)
            setMessage(e.target.value)
          }}
          rows={6}
          className="w-full bg-bg border border-border rounded p-2 text-[12px] font-mono resize-y mb-3 text-text"
          placeholder={i18nT('components.autoNudgePopover.describe_what_you_want_the_agent_to_accomplish')}
        />

        <div className="flex gap-3 mb-3">
          <div className="flex-1">
            <div className="text-muted text-[11px] mb-1">{i18nT('components.autoNudgePopover.seconds_between_nudges')}</div>
            <input
              type="number"
              aria-label={i18nT('components.autoNudgePopover.seconds_between_nudges')}
              min={15}
              max={86400}
              value={idleInput}
              onChange={e => { hasEdited.current = true; setIdleInput(e.target.value) }}
              onBlur={() => setIdleInput(String(parseIdle(idleInput)))}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-[12px] text-text"
            />
          </div>
          <div className="flex-1">
            <div className="text-muted text-[11px] mb-1">{i18nT('components.autoNudgePopover.max_cycles_0')}</div>
            <input
              type="number"
              aria-label={i18nT('components.autoNudgePopover.max_cycles_0_infinite')}
              min={0}
              value={maxCyclesInput}
              onChange={e => { hasEdited.current = true; setMaxCyclesInput(e.target.value) }}
              onBlur={() => setMaxCyclesInput(String(parseCycles(maxCyclesInput)))}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-[12px] text-text"
            />
          </div>
        </div>

        {loop && (
          <div className="text-muted text-[11px] mb-3">
            {i18nT('components.autoNudgePopover.last_fire')} {loop.last_fire_ts ? fmtTimeNumeric(loop.last_fire_ts) : i18nT('components.autoNudgePopover.never')}
            {countdownText && <span> · {countdownText}</span>}
          </div>
        )}

        {saveNotice === 'ignored' && (
          <div role="status" data-testid="autonudge-ignored-fields" className="text-warn text-[11px] mb-2">
            {i18nT('components.autoNudgePopover.ignored_fields_notice')}
          </div>
        )}

        {saveNotice === 'kept' && (
          <div role="status" data-testid="autonudge-kept-stored-goal" className="text-muted text-[11px] mb-2">
            {i18nT('components.autoNudgePopover.kept_stored_goal_notice')}
          </div>
        )}

        {/* No hand-off: the popover holds the unsaved goal message, idle and max-cycle inputs. */}
        <ErrorNotice
          variant="inline"
          className="mb-2"
          testId="auto-nudge-error"
          message={error}
          onDismiss={() => setError('')}
        />

        <div className="flex gap-2 justify-end">
          {loop && (
            <button
              onClick={stop}
              disabled={saving}
              className="px-3 py-1 rounded border border-border text-muted hover:text-danger hover:border-danger bg-transparent cursor-pointer disabled:opacity-50"
            >
              {i18nT('components.autoNudgePopover.stop_loop')}
            </button>
          )}
          <button
            onClick={() => save()}
            disabled={saving || !message.trim() || confirmPending}
            className="px-3 py-1 rounded bg-accent text-accent-fg border-none cursor-pointer disabled:opacity-50 hover:bg-accent/90"
          >
            {loop ? i18nT('components.autoNudgePopover.save') : i18nT('components.autoNudgePopover.start_loop')}
          </button>
        </div>
        {confirmPending && (
          <div className="flex flex-col items-end gap-2 mt-2">
            {confirmRearmed && (
              <p
                role="status"
                data-testid="autonudge-confirm-rearmed"
                className="m-0 text-warn text-[12px] font-medium"
              >
                {i18nT('components.autoNudgePopover.confirm_rearmed_notice')}
              </p>
            )}
            <p role="status" data-testid="autonudge-confirm-question" className="m-0 text-warn text-[12px]">
              {/* Moved wins when BOTH hold: only this arm names a goal the user has never
                  read, and the redacted arm's amber notice above still supplies its why. */}
              {i18nT(
                goalMovedUnderEdit
                  ? 'components.autoNudgePopover.confirm_overwrite_moved_question'
                  : 'components.autoNudgePopover.confirm_overwrite_question'
              )}
            </p>
            {goalMovedUnderEdit && (
              // The choice is irreversible and the newer text is in hand here, so show it
              // rather than asking the user to discard something they have never read.
              <p
                data-testid="autonudge-moved-goal-preview"
                className="m-0 max-w-full self-stretch text-text text-[12px] break-words opacity-80 max-h-32 overflow-y-auto"
              >
                {/* LABELLED: unlabelled text read as the user's own pending edit rather than
                    the stored goal being discarded. One key, so a translator can reorder it. */}
                {i18nT('components.autoNudgePopover.moved_goal_preview', {
                  // Shown IN FULL and scrolled rather than truncated: the click authorises
                  // destroying all of it, so an elided tail hides part of the decision.
                  goal: confirmArmedFor ?? '',
                })}
              </p>
            )}
            {/* Column unconditionally: the breakpoint keys on the VIEWPORT, but this row
                lives in a fixed 420px popover, so a wide screen wrapped long labels. */}
            <div className="flex flex-col gap-2 w-full">
              <button
                ref={dismissRef}
                data-testid="autonudge-dismiss-overwrite"
                onClick={() => {
                  // The WRITE-FREE exit: both other buttons PATCH, and the only silent
                  // dismissal was Escape, which DISCARDS the typed goal.
                  setConfirmOverwrite(false)
                  textareaRef.current?.focus()
                }}
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ' ') && e.repeat) e.preventDefault()
                }}
                // GHOST, not filled: this is the only arm that writes NOTHING, so it must
                // not share a shape with the arm that saves the other settings.
                className="px-3 py-1 rounded bg-transparent text-muted border-none underline cursor-pointer hover:text-text"
              >
                {i18nT('components.autoNudgePopover.dismiss_without_saving')}
              </button>
              <button
                data-testid="autonudge-decline-overwrite"
                onClick={() => {
                  // Dismiss the gate ONLY. Restoring the served text here discarded the
                  // user's typed goal, which no draft covers while a loop exists.
                  setConfirmOverwrite(false)
                  // This button unmounts with the gate, so focus would fall to <body> on
                  // the gate's own SAFE path. Land it on the text the user was editing.
                  textareaRef.current?.focus()
                  // Answers the GOAL question, not the whole form: persist the other
                  // settings so a changed interval is not silently dropped.
                  save({ keepStoredGoal: true })
                }}
                onKeyDown={e => {
                  // Same guard as the overwrite button: this one is focused on mount, so
                  // a repeating Enter from Save would otherwise dismiss the gate unseen.
                  if ((e.key === 'Enter' || e.key === ' ') && e.repeat) e.preventDefault()
                }}
                // OUTLINED: it does write (the other settings), so it is not the ghost
                // arm, and it is not destructive, so it is not the filled warn arm.
                className="px-3 py-1 rounded bg-card text-text border border-border cursor-pointer hover:opacity-90"
              >
                {i18nT('components.autoNudgePopover.keep_original_goal')}
              </button>
              <button
                data-testid="autonudge-confirm-overwrite"
                onClick={() => {
                  if (confirmBlocked) return
                  save()
                }}
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ' ') && e.repeat) e.preventDefault()
                }}
                // Truly disabled, not aria-disabled: an empty goal made this button swallow
                // the click silently, which reads as broken. The title names the reason.
                disabled={confirmBlocked}
                title={confirmBlocked && !message.trim() ? i18nT('components.autoNudgePopover.set_a_goal') : undefined}
                className={`px-3 py-1 rounded bg-warn text-warn-fg border-none cursor-pointer hover:bg-warn/90 ${confirmBlocked ? 'opacity-50' : ''}`}
              >
                {i18nT(
                  goalMovedUnderEdit
                    ? 'components.autoNudgePopover.confirm_overwrite_moved'
                    : 'components.autoNudgePopover.confirm_overwrite_masked'
                )}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
