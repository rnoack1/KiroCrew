/** Quota reclamation must not spend the reading position of the session in use.
 *
 *  A derived cache re-derives, but only by discarding what the reader can see: the anchor
 *  reopens at the bottom and the heights re-measure. A dead session's cache costs nobody
 *  anything, so it is spent first and the live session's only if nothing else frees space.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSessionIdentities,
  noteLiveSessionInstances,
  recordSessionStorageOwner,
} from '../utils/storageGc'

const LIVE = 'chat-live'
const DEAD = 'chat-dead'
const EPOCH = 'gw-epoch-7'
const CREATED = '2026-05-05T05:05:05Z'

const LIVE_ANCHOR = `vc_anchor3_${LIVE}`
const LIVE_HEIGHTS = `vc_heights_${LIVE}`
const DEAD_ANCHOR = `vc_anchor3_${DEAD}`
const OWNED_KEY = `mc-panel-tabs:${LIVE}`

const quotaStore = (store: Map<string, string>): Storage => {
  let full = true
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
    removeItem: (k: string) => { if (store.delete(k)) full = false },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
    clear: () => store.clear(),
  } as unknown as Storage
}

let store: Map<string, string>

beforeEach(() => {
  store = new Map([
    [LIVE_ANCHOR, '{"key":"row-9","top":120}'],
    [LIVE_HEIGHTS, '[[0,40]]'],
    [DEAD_ANCHOR, '{"key":"row-1","top":0}'],
    [OWNED_KEY, '{"tab":"files"}'],
  ])
  vi.stubGlobal('localStorage', quotaStore(store))
  noteLiveSessionInstances([{ key: LIVE, created: CREATED, incarnation: 'inc-1' }], { generation: 4, epoch: EPOCH })
})

afterEach(() => {
  __resetSessionIdentities()
  vi.unstubAllGlobals()
})

describe('reclamation spends a dead session before a live one', () => {
  it('keeps the live session’s scroll anchor', () => {
    recordSessionStorageOwner(OWNED_KEY)

    expect(store.get(LIVE_ANCHOR)).toBe('{"key":"row-9","top":120}')
  })

  it('keeps the live session’s measured heights', () => {
    recordSessionStorageOwner(OWNED_KEY)

    expect(store.has(LIVE_HEIGHTS)).toBe(true)
  })

  it('spends the dead session’s cache instead', () => {
    recordSessionStorageOwner(OWNED_KEY)

    expect(store.has(DEAD_ANCHOR)).toBe(false)
  })
})
