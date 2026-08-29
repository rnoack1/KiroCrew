/** A writer token must identify the INSTANCE, not the snapshot it was captured during.
 *
 *  Generation counts server emissions, so keying staleness on it makes any holder that
 *  outlives one snapshot read as superseded by its own session — and the panel-tab and
 *  scroll-anchor caches hold their token across exactly that gap, before a debounced flush.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionIdentities,
  noteLiveSessionInstances,
  sessionOwnerStamp,
  setSessionScopedItem,
} from '../utils/storageGc'

const ID = 'chat-long-lived'
const KEY = `mc-panel-tabs:${ID}`
const EPOCH = 'gw-epoch-4'
const CREATED = '2026-05-05T05:05:05Z'
const INCARNATION = 'inc-a'
const RESUMED_INCARNATION = 'inc-b'
const order = (generation: number) => ({ generation, epoch: EPOCH })

const MINE = '{"tab":"files"}'
const OTHER = '{"tab":"activity"}'

const listed = (incarnation: string) => [{ key: ID, created: CREATED, incarnation }]

beforeEach(() => localStorage.clear())

afterEach(() => {
  __resetSessionIdentities()
  localStorage.clear()
})

describe('a writer survives its own session emitting new snapshots', () => {
  it('accepts a flush whose token was captured several snapshots earlier', () => {
    noteLiveSessionInstances(listed(INCARNATION), order(4))
    const token = sessionOwnerStamp(ID)

    // The same instance, three further server emissions later.
    noteLiveSessionInstances(listed(INCARNATION), order(5))
    noteLiveSessionInstances(listed(INCARNATION), order(6))
    noteLiveSessionInstances(listed(INCARNATION), order(7))

    setSessionScopedItem(localStorage, KEY, MINE, token)

    expect(localStorage.getItem(KEY)).toBe(MINE)
  })

  it('still drops a flush from an instance the resume superseded', () => {
    noteLiveSessionInstances(listed(INCARNATION), order(4))
    const tokenBeforeResume = sessionOwnerStamp(ID)

    // Same key and same durable `created`; only the instance is new.
    noteLiveSessionInstances(listed(RESUMED_INCARNATION), order(9))
    setSessionScopedItem(localStorage, KEY, OTHER)

    setSessionScopedItem(localStorage, KEY, MINE, tokenBeforeResume)

    expect(localStorage.getItem(KEY)).toBe(OTHER)
  })

  it('accepts a write when the server reports no incarnation at all', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
    const token = sessionOwnerStamp(ID)

    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(8))
    setSessionScopedItem(localStorage, KEY, MINE, token)

    expect(localStorage.getItem(KEY)).toBe(MINE)
  })
})
