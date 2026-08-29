/** Quota reclamation must not spend the ownership proof that guards retained state.
 *
 *  `writeWouldBeStale` reads exactly one thing — the ledger row for the key — and treats a
 *  MISSING row as "not stale". So a reclaim that drops the row for state the app cannot
 *  rebuild does not lose bookkeeping, it opens a write window for a stale tab. This drives
 *  the real reclaimUnderQuota -> writeWouldBeStale path rather than asserting on the filter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSessionIdentities,
  noteLiveSessionInstances,
  recordSessionStorageOwner,
  setSessionScopedItem,
} from '../utils/storageGc'

const KEPT = 'chat-keeper'
const KEPT_KEY = `mc-panel-tabs:${KEPT}` // non-derived: no rebuild path
const OTHER = 'chat-other'
const OTHER_KEY = `mc-panel-tabs:${OTHER}`

const EPOCH = 'gw-epoch-1'
const REPLACEMENT_CREATED = '2026-05-05T10:00:00Z'
const STALE_CREATED = '2026-05-05T09:00:00Z'
const order = (generation: number) => ({ generation, epoch: EPOCH })

const REPLACEMENT_STATE = '{"tab":"files"}'
const STALE_STATE = '{"tab":"stale"}'

/** Refuses ledger writes until a real key is reclaimed, as a full origin store does. */
const quotaStore = (store: Map<string, string>): Storage => {
  let full = false
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full && k.startsWith('mc-storage-gc-owner:')) {
        const err = new Error('full') as Error & { name: string }
        err.name = 'QuotaExceededError'
        throw err
      }
      store.set(k, v)
    },
    removeItem: (k: string) => {
      if (store.delete(k)) full = false
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
    clear: () => store.clear(),
    __fill: () => { full = true },
  } as unknown as Storage & { __fill: () => void }
}

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', quotaStore(store))
})

afterEach(() => {
  __resetSessionIdentities()
  vi.unstubAllGlobals()
})

describe('quota reclamation keeps the proof that guards retained state', () => {
  it('refuses a stale tab’s overwrite after a reclaim ran', () => {
    // The replacement session owns real, non-rebuildable state.
    noteLiveSessionInstances([{ key: KEPT, created: REPLACEMENT_CREATED }], order(9))
    setSessionScopedItem(localStorage, KEPT_KEY, REPLACEMENT_STATE)
    expect(store.get(`mc-storage-gc-owner:${KEPT_KEY}`)).toBeDefined()

    // The store fills, and an unrelated session's stamp triggers reclamation.
    ;(localStorage as unknown as { __fill: () => void }).__fill()
    noteLiveSessionInstances([
      { key: KEPT, created: REPLACEMENT_CREATED },
      { key: OTHER, created: REPLACEMENT_CREATED },
    ], order(9))
    store.set(OTHER_KEY, '{"tab":"other"}')
    recordSessionStorageOwner(OTHER_KEY)

    // A stale tab of the SAME session now tries to write its older view.
    noteLiveSessionInstances([{ key: KEPT, created: STALE_CREATED }], order(4))
    setSessionScopedItem(localStorage, KEPT_KEY, STALE_STATE)

    expect(store.get(KEPT_KEY)).toBe(REPLACEMENT_STATE)
  })

  it('still reclaims the ledger row of a key that is already gone', () => {
    noteLiveSessionInstances([{ key: KEPT, created: REPLACEMENT_CREATED }], order(9))
    setSessionScopedItem(localStorage, KEPT_KEY, REPLACEMENT_STATE)
    store.delete(KEPT_KEY) // value evicted elsewhere; the row now stamps nothing

    ;(localStorage as unknown as { __fill: () => void }).__fill()
    noteLiveSessionInstances([
      { key: KEPT, created: REPLACEMENT_CREATED },
      { key: OTHER, created: REPLACEMENT_CREATED },
    ], order(9))
    store.set(OTHER_KEY, '{"tab":"other"}')
    recordSessionStorageOwner(OTHER_KEY)

    expect(store.has(`mc-storage-gc-owner:${KEPT_KEY}`)).toBe(false)
  })
})
