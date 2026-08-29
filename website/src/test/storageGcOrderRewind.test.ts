/** A tab applying an old snapshot must not rewind the shared order and re-license its writes. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionIdentities,
  noteLiveSessionInstances,
  setSessionScopedItem,
} from '../utils/storageGc'

const ID = 'chat-41'
const KEY = `mc-panel-tabs:${ID}`
const OLD_EPOCH = 'gw-epoch-old'
const NEW_EPOCH = 'gw-epoch-new'
const OLD_CREATED = '2026-01-01T00:00:00Z'
const NEW_CREATED = '2026-02-02T00:00:00Z'

const storedOrder = () => JSON.parse(localStorage.getItem('mc-storage-gc-order') ?? 'null')

afterEach(() => {
  __resetSessionIdentities()
  localStorage.clear()
})

describe('the shared order does not rewind to a superseded epoch', () => {
  beforeEach(() => localStorage.clear())

  it('refuses a stale tab write after that tab re-applies its own old snapshot', () => {
    // This tab once saw the old epoch, so it is in the shared order's history.
    noteLiveSessionInstances([{ key: ID, created: OLD_CREATED }], {
      generation: 5,
      epoch: OLD_EPOCH,
    })
    // The replacement session, under the NEW epoch, writes and owns the key.
    __resetSessionIdentities()
    noteLiveSessionInstances([{ key: ID, created: NEW_CREATED }], {
      generation: 2,
      epoch: NEW_EPOCH,
    })
    setSessionScopedItem(localStorage, KEY, '{"tab":"replacement"}')
    expect(localStorage.getItem(KEY)).toBe('{"tab":"replacement"}')

    // The old-epoch tab applies its stale snapshot again. Its own liveInstances go back
    // to the old identity, and the shared order must NOT follow it back.
    __resetSessionIdentities()
    noteLiveSessionInstances([{ key: ID, created: OLD_CREATED }], {
      generation: 5,
      epoch: OLD_EPOCH,
    })
    expect(storedOrder()?.epoch).toBe(NEW_EPOCH)

    setSessionScopedItem(localStorage, KEY, '{"tab":"stale"}')

    expect(localStorage.getItem(KEY)).toBe('{"tab":"replacement"}')
  })

  it('still advances the order within the current epoch', () => {
    noteLiveSessionInstances([{ key: ID, created: OLD_CREATED }], {
      generation: 5,
      epoch: OLD_EPOCH,
    })
    noteLiveSessionInstances([{ key: ID, created: OLD_CREATED }], {
      generation: 6,
      epoch: OLD_EPOCH,
    })

    expect(storedOrder()?.generation).toBe(6)
  })

  it('accepts a genuinely new epoch', () => {
    noteLiveSessionInstances([{ key: ID, created: OLD_CREATED }], {
      generation: 5,
      epoch: OLD_EPOCH,
    })
    noteLiveSessionInstances([{ key: ID, created: NEW_CREATED }], {
      generation: 1,
      epoch: NEW_EPOCH,
    })

    expect(storedOrder()?.epoch).toBe(NEW_EPOCH)
  })
})
