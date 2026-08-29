/** A write scheduled before the close must not un-close the session when it lands. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionIdentities,
  gcOrphanedStorage,
  noteLiveSessionInstances,
  noteSessionClosed,
  recordSessionStorageOwner,
  sessionOwnerStamp,
  setSessionScopedItem,
} from '../utils/storageGc'

const ID = 'slack:1757000000'
const KEY = `mc-panel-tabs:${ID}`
const EPOCH = 'gw-epoch-9'
const CREATED = '2026-05-05T05:05:05Z'
const order = (generation: number) => ({ generation, epoch: EPOCH })
const closedMarker = () => localStorage.getItem(`mc-storage-gc-closed:${ID}`)

afterEach(() => {
  __resetSessionIdentities()
  localStorage.clear()
})

describe('closure proof survives a straggler write from the closed instance', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the marker when the late write is the closed instance itself', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
    setSessionScopedItem(localStorage, KEY, '{"tab":"files"}')
    noteSessionClosed(ID)
    expect(closedMarker()).not.toBeNull()

    // the debounced write that was already in flight when the close resolved
    recordSessionStorageOwner(KEY)

    expect(closedMarker()).not.toBeNull()
  })

  it('still collects the session whose proof the straggler tried to erase', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
    setSessionScopedItem(localStorage, KEY, '{"tab":"files"}')
    noteSessionClosed(ID)
    recordSessionStorageOwner(KEY)

    gcOrphanedStorage([], order(9))

    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('a genuinely different instance under the key does clear the marker', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
    setSessionScopedItem(localStorage, KEY, '{"tab":"files"}')
    noteSessionClosed(ID)

    __resetSessionIdentities()
    noteLiveSessionInstances([{ key: ID, created: '2026-06-06T06:06:06Z' }], order(5))
    setSessionScopedItem(localStorage, KEY, '{"tab":"live"}', sessionOwnerStamp(ID))

    expect(closedMarker()).toBeNull()
  })
})
