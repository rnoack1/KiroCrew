/**
 * Per-slot marker for a send whose payload a failure arm handed back to the composer.
 *
 * The restored payload is PERSISTED (it is a draft), so this marker must MATCH the draft's
 * durability exactly: same backing store, same TTL, same cap. A shorter-lived marker leaves
 * the risky payload in the composer with no caption after a tab reopen, and a longer-lived
 * one would caption a draft that has already expired out from under it.
 */
import { DRAFT_MAX_ENTRIES, DRAFT_TTL_MS } from './draftConstants'
import { createSlotDraftStore } from './slotDraftStore'

export const STAGED_SENDS_KEY = 'mc-chat-staged-sends'

/** Coerce to a non-empty sendId, or null. */
const sanitizeSendId = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null

const store = createSlotDraftStore<string>({
  key: STAGED_SENDS_KEY,
  storage: 'local',
  ttlMs: DRAFT_TTL_MS,
  maxEntries: DRAFT_MAX_ENTRIES,
  sanitize: sanitizeSendId,
})

export const loadStagedSends = store.load
export const saveStagedSends = store.save
export const setStagedSendMarker = store.set
