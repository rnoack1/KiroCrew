/** A write that postdates the close proves the session came back, whatever the snapshot says. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionIdentities,
  gcOrphanedStorage,
  noteLiveSessionInstances,
  noteSessionClosed,
  setSessionScopedItem,
} from '../utils/storageGc'

const ID = 'chat-51'
const ANCHOR = `vc_anchor3_${ID}`
const TABS = `mc-panel-tabs:${ID}`
const EPOCH = 'gw-epoch-7'
// A same-key resume keeps its creation stamp, so the stamp cannot tell the two apart.
const CREATED = '2026-04-04T04:04:04Z'
const order = (generation: number) => ({ generation, epoch: EPOCH })

afterEach(() => {
  __resetSessionIdentities()
  localStorage.clear()
})

describe('a stale absent snapshot does not delete a resumed session', () => {
  beforeEach(() => localStorage.clear())

  it('keeps derived state the resumed instance wrote after the close', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
    setSessionScopedItem(localStorage, ANCHOR, '{"index":12}')
    noteSessionClosed(ID)

    // Resumed under the same key, same creation stamp, and it scrolls again.
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(7))
    setSessionScopedItem(localStorage, ANCHOR, '{"index":99}')

    // A boot snapshot that predates the resume: the id is absent from its live map.
    gcOrphanedStorage([], order(9))

    expect(localStorage.getItem(ANCHOR)).toBe('{"index":99}')
  })

  it('keeps non-derived state on the same proof', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
    setSessionScopedItem(localStorage, TABS, '{"tab":"files"}')
    noteSessionClosed(ID)

    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(7))
    setSessionScopedItem(localStorage, TABS, '{"tab":"live"}')

    gcOrphanedStorage([], order(9))

    expect(localStorage.getItem(TABS)).toBe('{"tab":"live"}')
  })

  it('still collects derived state of a session that never came back', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED }], order(4))
    setSessionScopedItem(localStorage, ANCHOR, '{"index":12}')
    noteSessionClosed(ID)

    gcOrphanedStorage([], order(9))

    expect(localStorage.getItem(ANCHOR)).toBeNull()
  })
})
