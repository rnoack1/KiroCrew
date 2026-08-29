/** A full store must not be able to destroy the evidence that licenses reclamation. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSessionIdentities,
  noteLiveSessionInstances,
  recordSessionStorageOwner,
} from '../utils/storageGc'

const ID = 'chat-1'
const KEY = `mc-panel-tabs:${ID}`
const EPOCH = 'gw-epoch-9'
const CREATED = '2026-05-05T05:05:05Z'
const order = (generation: number) => ({ generation, epoch: EPOCH })

const DRAFT = 'mc-draft-chat-1'
const DERIVED = 'vc_heights_chat-9'
const FOREIGN_LEDGER = 'mc-storage-gc-owner:chat-9'
const OWN_LEDGER = `mc-storage-gc-owner:${KEY}`

/** Refuses ledger writes until something is reclaimed, which is what a real quota does. */
const quotaUntilReclaimed = (store: Map<string, string>): Storage => {
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
    removeItem: (k: string) => {
      // Only a key that actually existed frees space; `clearClosed` removes an absent
      // marker on this path, and treating that as room made the retry unreachable.
      if (store.delete(k)) full = false
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
    clear: () => store.clear(),
  } as unknown as Storage
}

let store: Map<string, string>

beforeEach(() => {
  store = new Map([
    [DRAFT, 'unsent words'],
    [DERIVED, '[[0,10]]'],
    [FOREIGN_LEDGER, '{"stamp":"2026-01-01T00:00:00Z","generation":1}'],
  ])
  vi.stubGlobal('localStorage', quotaUntilReclaimed(store))
  noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
})

afterEach(() => {
  __resetSessionIdentities()
  vi.unstubAllGlobals()
})

describe('quota exhaustion has a proof-free escape', () => {
  it('lands the owner entry after reclaiming', () => {
    recordSessionStorageOwner(KEY)

    expect(store.has(OWN_LEDGER)).toBe(true)
  })

  it('never spends a draft to make room', () => {
    recordSessionStorageOwner(KEY)

    expect(store.get(DRAFT)).toBe('unsent words')
  })

  it('spends the rebuildable derived cache instead', () => {
    recordSessionStorageOwner(KEY)

    expect(store.has(DERIVED)).toBe(false)
  })
})
