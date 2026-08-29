/** The queued-send stashes, in a module of their own.
 *
 *  Deliberately NOT in `useQueuedMessageActions`: the slot-detail hydration path in `chatSlice`
 *  has to adopt a pre-send record when the `queue_push` broadcast was missed, and importing the
 *  hook module from the slice closes an import cycle (the hook imports the slice's action
 *  creators) which leaves `chatReducer` undefined at module-init. No React, no store imports --
 *  so every writer and reader can share the one store. */

/** Pre-serialization composer state of a send the server QUEUED, written by the
 *  host's send path when the `queued: true` receipt names the entry. */
export interface QueuedSendRecord {
  /** The text exactly as the user typed it. */
  raw: string
  /** The staged file paths at send time. */
  files: string[]
  /** The exact POSTed LLM-facing text — the edit guard: an entry edited after
   *  send keeps its queue id but fails this equality, so an edited card falls
   *  to the parser instead of clobbering the edit with pre-edit state. */
  sent: string
}

/** Queued-send stash, keyed by the `queue_id` the send receipt returns (the
 *  same id `queue_push` broadcasts and the card's cancel button carries).
 *  Queue identity is the ONLY sound key: the serialization is not injective
 *  (image @-tokens are erased from the LLM-facing text), so content-keyed
 *  records can collide across different captions, duplicate sends, and other
 *  tabs. Module-level so every host's send path (ChatPage, ChatPane) writes
 *  the one store this hook's cancel consumes — the same one-owner reasoning
 *  as the hook itself (#5891). Deliberately unevicted: an entry dies on the
 *  cancel that consumes it, and evicting a live entry would degrade that
 *  card's cancel to the parser fallback; orphans from normal delivery are
 *  three small strings bounded by queued sends per tab session. */
export const queuedSendStash = new Map<string, QueuedSendRecord>()

/** The same records keyed by `sendId` and written BEFORE the POST, because the queue id only
 *  arrives with the receipt. A send whose 2xx body is unreadable never learns its queue id, and
 *  a BUSY send has no optimistic row either, so `appendQueuedMessage` finds no raw text to carry
 *  and a later cancel would restore only the server's redacted copy, dropping the attachments. */
export const preSendStash = new Map<string, QueuedSendRecord>()

/** Only an outcome that can still produce a `queue_push` leaves a record unresolved, so the live
 *  set is the handful of sends whose receipt was unreadable — never the tab's whole send history. */
const PRE_SEND_STASH_MAX = 20

/** Write a pre-send record, evicting the oldest past the cap. Unlike `queuedSendStash`, whose
 *  entries die on the cancel that consumes them, an unresolved record has no such reader. */
export function stashPreSend(sendId: string, rec: QueuedSendRecord): void {
  // Re-inserted rather than overwritten, so a rewritten record counts as the NEWEST for eviction.
  preSendStash.delete(sendId)
  preSendStash.set(sendId, rec)
  while (preSendStash.size > PRE_SEND_STASH_MAX) {
    const oldest = preSendStash.keys().next().value
    if (oldest === undefined) break
    preSendStash.delete(oldest)
  }
}

/** Retire a record once the send's outcome rules out a `queue_push` naming it: an immediate
 *  dispatch or a refusal. A queued acceptance does NOT qualify — its push is still to come. */
export function retirePreSendStash(sendId: string | undefined): void {
  if (sendId) preSendStash.delete(sendId)
}

/** Move a pre-send record onto the queue id the server assigned, once `queue_push` names both.
 *
 *  `content` is the BROADCAST text, and it becomes the record's `sent`: the cancel guard compares
 *  `sent` against the card's own content, which the server may have REDACTED (image @-tokens are
 *  erased). Keeping the sender's raw text there failed that guard, so cancel fell to the parser and
 *  restored the masked copy WITHOUT the attachments — the loss this stash exists to prevent. */
export function adoptPreSendStash(sendId: string | undefined, queueId: string | undefined, content?: string): void {
  if (!sendId || !queueId) return
  const rec = preSendStash.get(sendId)
  const existing = queuedSendStash.get(queueId)
  if (!rec && !existing) return
  if (rec) preSendStash.delete(sendId)
  // The receipt's copy of {raw, files} is written from the sending surface and stays authoritative;
  // only the BROADCAST content settles `sent`, so a receipt that landed first is UPDATED, not skipped.
  const base = existing ?? rec as QueuedSendRecord
  queuedSendStash.set(queueId, typeof content === 'string' ? { ...base, sent: content } : base)
}

/** Write the receipt-path record, PRESERVING one `queue_push` already adopted.
 *
 *  `queue_push` can win the race against its own HTTP receipt. The adopted record's `sent` is the
 *  server's BROADCAST content, which is what the cancel guard compares against the card; the
 *  receipt's is the sender's un-redacted copy. Overwriting therefore broke cancel on a redacted
 *  entry, dropping the attachments the parser fallback cannot recover. */
export function stashQueuedSend(queueId: string | undefined, rec: QueuedSendRecord): void {
  if (!queueId || queuedSendStash.has(queueId)) return
  queuedSendStash.set(queueId, rec)
}

/** Drop an adopted record once the entry is EDITED: its raw payload is no longer what the card
 *  says, so restoring it on a later cancel would clobber the edit with pre-edit state. */
export function invalidateQueuedSendStash(queueId: string | undefined): void {
  if (queueId) queuedSendStash.delete(queueId)
}
