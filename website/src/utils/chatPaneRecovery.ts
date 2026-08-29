/**
 * Per-slot persistence for a pane send the transport handed back — the text, the
 * attachments and the send id it was minted with.
 *
 * `ChatPane` used to hold this in a component ref (`strandedSends`), so the payload
 * of a send that timed out before reaching the gateway existed in exactly one place
 * that a reload destroyed. The composer had already been cleared, and the optimistic
 * bubble is store-only, so nothing else carried the user's words.
 *
 * localStorage, deliberately, and on the same TTL as `chatDrafts`. This store owns BOTH
 * surfaces' records — the pane's payload and ChatPage's marker-only form — because they are
 * one concept and were previously two stores that had to expire together by hand. A payload in
 * sessionStorage would die on tab close while a marker survived, leaving a warning about a send
 * whose text is gone — strictly worse than losing both.
 */
import { safeSetItem } from './safeStorage'
import { DRAFT_MAX_ENTRIES, DRAFT_TTL_MS, RECOVERY_MAX_STORE_BYTES } from './draftConstants'

export const PANE_RECOVERY_KEY = 'mc-chat-pane-recovery'

export interface PaneRecovery {
  /** Empty on ChatPage's marker-only record: it names the send without carrying a payload. */
  text: string
  files: string[]
  sendId?: string
  /** Bumped on every write, so a receipt can tell the payload it consumed from a newer draft. */
  gen?: number
  /** The SEND's own fragment, distinct from `text` when the composer had mid-flight work merged
   *  into it. Gates the Discard exit, which must never offer to delete more than it restored. */
  sent?: string
  sentFiles?: string[]
  /** The browsing context that parked this. Two tabs on one slot share the store, so without it the
   *  slot-wide reader handed a sibling's send over and this tab's settlement then retired it. */
  tabId?: string
}

export type PaneRecoveries = Record<string, PaneRecovery>

/** Reject anything not shaped like a recovery, so a hand-edited or older value is
 *  dropped rather than restored as a half-record. */
const sanitize = (v: unknown): PaneRecovery | null => {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const text = typeof r.text === 'string' ? r.text : ''
  const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : []
  const sendId = typeof r.sendId === 'string' && r.sendId ? r.sendId : undefined
  // A record must carry SOMETHING: a payload, or the send id whose caption it drives.
  if (!text && !files.length && !sendId) return null
  const gen = typeof r.gen === 'number' && Number.isFinite(r.gen) ? r.gen : undefined
  const sent = typeof r.sent === 'string' ? r.sent : undefined
  const sentFiles = Array.isArray(r.sentFiles) ? r.sentFiles.filter((f): f is string => typeof f === 'string') : undefined
  const tabId = typeof r.tabId === 'string' && r.tabId ? r.tabId : undefined
  return {
    text,
    files,
    ...(sendId ? { sendId } : {}),
    ...(gen !== undefined ? { gen } : {}),
    ...(sent !== undefined ? { sent } : {}),
    ...(sentFiles !== undefined ? { sentFiles } : {}),
    ...(tabId ? { tabId } : {}),
  }
}

/** ONE storage key per record.
 *
 *  A single shared blob made every write a cross-tab read-modify-write: two tabs that read the
 *  blob before either saved lost the earlier record, and a payload has no second copy once it is
 *  gone. Re-reading immediately before the write narrowed that window without closing it, because
 *  the interleaving happens between processes. Per-record keys remove the shared cell instead, so
 *  two sends cannot collide at all — no lock, and no window to serialize. */
const fullKey = (k: string): string => `${PANE_RECOVERY_KEY}:${k}`
const isFullKey = (s: string): boolean => s.startsWith(`${PANE_RECOVERY_KEY}:`)
const shortKey = (s: string): string => s.slice(PANE_RECOVERY_KEY.length + 1)

interface Stamped { v: unknown; ts: number }
type Live = Record<string, { rec: PaneRecovery; ts: number }>

const ls = (): Storage | null => {
  try { return localStorage } catch { return null }
}

const drop = (full: string): void => {
  try { ls()?.removeItem(full) } catch { /* a failed delete is retried on the next read */ }
}

/** Every live record, pruning anything expired or unparseable as it goes. */
const readLive = (): Live => {
  const out: Live = {}
  const s = ls()
  if (!s) return out
  const doomed: string[] = []
  for (let i = 0; i < s.length; i++) {
    const full = s.key(i)
    if (!full || !isFullKey(full)) continue
    try {
      const parsed = JSON.parse(s.getItem(full) || 'null') as Stamped | null
      const rec = parsed && typeof parsed.ts === 'number' ? sanitize(parsed.v) : null
      if (!rec || Date.now() - (parsed as Stamped).ts > DRAFT_TTL_MS) { doomed.push(full); continue }
      out[shortKey(full)] = { rec, ts: (parsed as Stamped).ts }
    } catch { doomed.push(full) }
  }
  for (const d of doomed) drop(d)
  return out
}

/** `safeSetItem`, not a bare `setItem`: this record is the only copy of a prompt the composer has
 *  already cleared, and `enforceBudget` runs AFTER the write and evicts only this store — so an
 *  origin filled by uncapped siblings left the write permanently failed and silently lost it.
 *
 *  Returns whether it LANDED. `safeSetItem` still answers false when the quota is exhausted and
 *  reclaim frees nothing, and discarding that made a failed write indistinguishable from a durable
 *  one — so the caller believed a prompt was recoverable when nothing had been stored. */
const writeOne = (key: string, rec: PaneRecovery, ts: number): boolean =>
  safeSetItem(fullKey(key), JSON.stringify({ v: rec, ts } satisfies Stamped))

/** A record still CARRYING work — the thing this store exists to be the only copy of. Markers
 *  (`setStagedSend` writes an empty one purely to name a send) carry none. */
const holdsPrompt = (rec: PaneRecovery): boolean =>
  rec.text.trim().length > 0 || rec.files.length > 0

/** Bounds the store WITHOUT ever deleting an unresolved prompt.
 *
 *  Only markers are evictable. Evicting by age here reached the oldest RECORD, which past the
 *  entry cap is the only durable copy of a prompt the composer already cleared — so an
 *  intermittently-offline user accumulating recoveries silently lost the earliest one. A prompt
 *  leaves only by settlement (discard, a definitive receipt) or by the TTL that expires stale
 *  content. When markers alone cannot bring the store under budget, the cap yields: `writeOne`
 *  goes through `safeSetItem`, which reclaims disposable caches instead. */
const enforceBudget = (keep?: string): void => {
  const live = readLive()
  const bytes = (): number =>
    Object.entries(live).reduce((n, [k, e]) => n + fullKey(k).length + JSON.stringify({ v: e.rec, ts: e.ts }).length, 0)
  const evictable = (): string[] =>
    Object.entries(live)
      .filter(([k, e]) => k !== keep && !holdsPrompt(e.rec))
      .sort((a, b) => a[1].ts - b[1].ts)
      .map(([k]) => k)
  let next = evictable()
  while ((Object.keys(live).length > DRAFT_MAX_ENTRIES || bytes() > RECOVERY_MAX_STORE_BYTES) && next.length) {
    drop(fullKey(next[0]))
    delete live[next[0]]
    next = evictable()
  }
}

const loadPaneRecoveries = (): PaneRecoveries => {
  const out: PaneRecoveries = {}
  for (const [k, e] of Object.entries(readLive())) out[k] = e.rec
  return out
}

/** @internal test-only */
export const __resetPaneRecoveryForTests = (): void => {
  const s = ls()
  if (s) {
    const doomed: string[] = []
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && isFullKey(k)) doomed.push(k) }
    for (const d of doomed) drop(d)
  }
}

/** ChatPage's marker for a restored send, in this same store under a SURFACE-QUALIFIED key.
 *
 *  Qualified because the two surfaces can address ONE slot at the same time: `MembersPage`
 *  renders `<ChatPane slotKey={activeSlot}>`, so an unqualified key would let the page's
 *  marker overwrite the pane's payload for that slot — losing exactly the words this store
 *  exists to keep. One store, one record shape, one TTL; two records that cannot collide. */
const pageKey = (slot: string): string => `page:${slot}`

/** A pane payload is keyed by SLOT **and SEND**, because two tabs can each hand back a failed
 *  send for the same slot: one shared key made the later write replace the earlier prompt, and
 *  a payload has no in-system recovery once overwritten (unlike a draft, which the composer
 *  still holds). `slotDraftStore`'s accepted last-write-wins covers drafts for that reason and
 *  does not extend here. */
/** Identifies THIS browsing context for the recovery store.
 *
 *  sessionStorage is the only per-tab store that ALSO survives a reload, and both halves are load
 *  bearing: `api/tabId`'s in-memory id is per page LOAD, so owning by it would refuse a reload its
 *  own park -- the case this store exists for. Read rather than memoized so a new context is exactly
 *  an empty sessionStorage.
 */
const TAB_OWNER_KEY = `${PANE_RECOVERY_KEY}:tab`
const paneTabId = (): string | undefined => {
  try {
    const s = globalThis.sessionStorage
    if (!s) return undefined
    const existing = s.getItem(TAB_OWNER_KEY)
    if (existing) return existing
    const minted = globalThis.crypto?.randomUUID?.() ?? `t-${Math.random().toString(36).slice(2)}-${Date.now()}`
    s.setItem(TAB_OWNER_KEY, minted)
    return minted
  } catch {
    // No sessionStorage (private mode, blocked storage): stamp nothing, so records stay adoptable
    // exactly as before. Losing the cross-tab guard beats losing recovery outright.
    return undefined
  }
}

/** Whether this context may take a record. An UNOWNED record stays adoptable -- one parked before
 *  this shipped, or by a context with no sessionStorage -- because refusing it would strand a real
 *  prompt, the same harm class as the cross-tab overwrite. */
const ownedHere = (rec: PaneRecovery): boolean => {
  const mine = paneTabId()
  return !rec.tabId || !mine || rec.tabId === mine
}

const paneKey = (slot: string, sendId?: string): string =>
  sendId ? `pane:${slot}|${sendId}` : `pane:${slot}`

const ownsSlot = (key: string, slot: string): boolean =>
  key === paneKey(slot) || key.startsWith(`${paneKey(slot)}|`)

/** The newest record parked for a slot, by `gen`, since several sends can be parked at once. */
export const loadPaneRecovery = (slot: string): PaneRecovery | undefined => {
  const all = loadPaneRecoveries()
  let best: PaneRecovery | undefined
  for (const [k, rec] of Object.entries(all)) {
    if (!ownsSlot(k, slot) || !ownedHere(rec)) continue
    if (!best || (rec.gen ?? 0) >= (best.gen ?? 0)) best = rec
  }
  return best
}

/** Re-reading no longer matters: this writes ONE key, so a concurrent tab's record for another
 *  send is untouched rather than merely likely to survive.
 *
 *  Returns whether the record is actually DURABLE. A caller holding the only other copy must keep
 *  it when this answers false, rather than clearing on the assumption that the store took it. */
export const setPaneRecoveryFor = (slot: string, rec: PaneRecovery): boolean => {
  const key = paneKey(slot, rec.sendId)
  const owned = rec.tabId ? rec : { ...rec, ...(paneTabId() ? { tabId: paneTabId() } : {}) }
  const landed = writeOne(key, owned, Date.now())
  enforceBudget(key)
  // Read back rather than trusting the return alone: the budget pass runs after the write, and a
  // failure there would leave a `true` naming a record that is no longer on disk.
  return landed && readLive()[key] !== undefined
}

/** The record for ONE named send, for a caller that must not act on merely the newest. */
export const loadPaneRecoveryById = (slot: string, sendId: string): PaneRecovery | undefined => {
  const rec = readLive()[paneKey(slot, sendId)]?.rec
  return rec && ownedHere(rec) ? rec : undefined
}

/** Re-key an UNIDENTIFIED record onto the send now resending it, and return it.
 *
 *  A refusal restores without a send id, so its record lands under the bare slot key with nothing
 *  able to retire it: the retry's settlement found no match and a reload resurrected a prompt the
 *  server had since accepted. Binding it here gives that settlement something to retire. */
export const adoptPaneRecovery = (slot: string, sendId: string): PaneRecovery | undefined => {
  const bare = readLive()[paneKey(slot)]?.rec
  if (!bare || !ownedHere(bare)) return undefined
  const bound = { ...bare, sendId }
  const boundKey = paneKey(slot, sendId)
  // The bare record is the only durable copy, so the drop waits on the re-key LANDING. An exhausted
  // quota that reclaim cannot relieve otherwise deleted the prompt and wrote nothing in its place.
  if (!writeOne(boundKey, bound, Date.now()) || readLive()[boundKey] === undefined) return undefined
  drop(fullKey(paneKey(slot)))
  return bound
}

/** Retires ONE send's record, named by its id, leaving another tab's parked send for the same slot.
 *
 *  The id is REQUIRED, and deliberately so: two tabs on one slot is a shape this feature's own
 *  tests exercise, and a slot-wide sweep there deleted a sibling's only copy. With no positive
 *  ownership identity the correct action is to retain, so there is no arm that can guess. An
 *  unidentified record is retired by `adoptPaneRecovery` re-keying it onto the send that resends it. */
export const clearPaneRecoveryFor = (slot: string, sendId: string): void => {
  drop(fullKey(paneKey(slot, sendId)))
}

/** Retires the slot's UNIDENTIFIED record — the one a refusal restored without a send id.
 *
 *  Deliberately ONE deterministic key rather than a sweep over everything `ownsSlot` matches: the
 *  bare key is itself a positive identity, and it cannot name a sibling tab's `slot|sendId` record. */
export const clearUnidentifiedPaneRecovery = (slot: string): void => {
  drop(fullKey(paneKey(slot)))
}

export const loadStagedSend = (slot: string): string | undefined =>
  readLive()[pageKey(slot)]?.rec.sendId

export const setStagedSend = (slot: string, sendId: string): void => {
  const key = pageKey(slot)
  writeOne(key, { text: '', files: [], sendId }, Date.now())
  enforceBudget(key)
}

export const clearStagedSend = (slot: string): void => {
  drop(fullKey(pageKey(slot)))
}
