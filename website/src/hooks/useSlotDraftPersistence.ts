/**
 * Persist a side/embedded composer's draft against its slot.
 *
 * The close guard's cross-window claim expires, so an in-memory draft in a window that
 * froze in the background became invisible and a close elsewhere destroyed it. Writing
 * the text to storage is what makes expiry safe: the guard's persisted fallback never
 * ages out, so the draft stays discoverable after the claim is gone.
 *
 * Flushes on the debounce alone. An UNMOUNT deliberately CLEARS ITS OWN entry instead: the
 * panel being dismissed takes its draft with it, so a persisted copy would block that slot's
 * close for the store's whole TTL while nothing on screen held the draft it named.
 *
 * That still closes the hole this exists for, because the case it guards is a window that
 * FREEZES — which never unmounts. Its debounced write has already landed, so the draft stays
 * discoverable after the cross-window claim ages out. A window that crashes outright runs no
 * cleanup either, so its copy survives too.
 */
import { useEffect, useRef } from 'react'

import { DRAFT_SAVE_DEBOUNCE_MS } from '../utils/draftConstants'
import { nextComposerId } from '../utils/slotComposerRegistry'
import { clearSideDraft, writeSideDraft } from '../utils/sideComposerDrafts'

export function useSlotDraftPersistence(slot: string | null, text: string): void {
  const latest = useRef({ slot, text })
  latest.current = { slot, text }
  // Minted here rather than taken as a prop, so no host has to thread it and no host can
  // pass one that collides. The id is unique across windows, not just within this one.
  const composerId = useRef<string>()
  if (!composerId.current) composerId.current = nextComposerId()
  const id = composerId.current

  useEffect(() => {
    if (!slot) return
    const timer = setTimeout(() => writeSideDraft(id, slot, text), DRAFT_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [id, slot, text])

  useEffect(() => () => {
    // Removes THIS composer's key only. A sibling bound to the same slot keeps its own, so
    // dismissing one panel cannot discard a draft still on screen in another.
    if (latest.current.slot) clearSideDraft(id)
  }, [id])
}
