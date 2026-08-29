/**
 * Per-slot persistence for a pane send the transport handed back — the text, the
 * attachments and the send id it was minted with.
 *
 * `ChatPane` used to hold this in a component ref (`strandedSends`), so the payload
 * of a send that timed out before reaching the gateway existed in exactly one place
 * that a reload destroyed. The composer had already been cleared, and the optimistic
 * bubble is store-only, so nothing else carried the user's words.
 *
 * localStorage, deliberately, and on the same TTL as `chatDrafts`: the caption that
 * warns about this send is persisted in `chatStagedSends`, also local. A payload in
 * sessionStorage would die on tab close while that marker survived, leaving a warning
 * about a send whose text is gone — strictly worse than losing both.
 */
import { createSlotDraftStore } from './slotDraftStore'
import { DRAFT_MAX_ENTRIES, DRAFT_MAX_STORE_BYTES, DRAFT_TTL_MS } from './draftConstants'

export const PANE_RECOVERY_KEY = 'mc-chat-pane-recovery'

export interface PaneRecovery {
  text: string
  files: string[]
  sendId?: string
  /** Bumped on every write, so a receipt can tell the payload it consumed from a newer draft. */
  gen?: number
}

export type PaneRecoveries = Record<string, PaneRecovery>

/** Reject anything not shaped like a recovery, so a hand-edited or older value is
 *  dropped rather than restored as a half-record. */
const sanitize = (v: unknown): PaneRecovery | null => {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (typeof r.text !== 'string') return null
  const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : []
  if (!r.text && !files.length) return null
  const sendId = typeof r.sendId === 'string' && r.sendId ? r.sendId : undefined
  const gen = typeof r.gen === 'number' && Number.isFinite(r.gen) ? r.gen : undefined
  return { text: r.text, files, ...(sendId ? { sendId } : {}), ...(gen !== undefined ? { gen } : {}) }
}

const store = createSlotDraftStore<PaneRecovery>({
  key: PANE_RECOVERY_KEY,
  storage: 'local',
  ttlMs: DRAFT_TTL_MS,
  // Same limits as `chatDrafts`, and for the same reason: unbounded growth ends in a quota
  // failure whose victim is the NEWEST write, so the record a reload needs is the one lost.
  maxEntries: DRAFT_MAX_ENTRIES,
  maxStoreBytes: DRAFT_MAX_STORE_BYTES,
  sanitize,
})

export const loadPaneRecoveries = store.load
export const savePaneRecoveries = store.save
export const setPaneRecovery = store.set
/** @internal test-only */
export const __resetPaneRecoveryForTests = store.__resetForTests
