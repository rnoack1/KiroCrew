/** A resume on the same key preserves `created`, so the stamp cannot identify the writer.
 *
 *  Both ownership guards compared stamps only, and a same-key resume makes those stamps equal,
 *  so a delayed write from the superseded instance satisfies each guard and lands on top of the
 *  resumed session's state. The writer token therefore carries the frame identity too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionIdentities,
  noteLiveSessionInstances,
  sessionOwnerStamp,
  setSessionScopedItem,
} from '../utils/storageGc'

const ID = 'chat-resumed'
const KEY = `mc-panel-tabs:${ID}`
const EPOCH = 'gw-epoch-3'
// The SAME durable identity across the close and the resume, which is the whole difficulty.
const CREATED = '2026-05-05T05:05:05Z'
const order = (generation: number) => ({ generation, epoch: EPOCH })
// A resume mints a NEW incarnation while `created` is preserved, which is the case the
// stamp alone cannot separate. The server emits an incarnation on every slot row.
const FIRST = 'inc-first'
const AFTER_RESUME = 'inc-after-resume'

const OLD_VIEW = '{"tab":"files"}'
const RESUMED_VIEW = '{"tab":"activity"}'
const STRAGGLER_VIEW = '{"tab":"stale-straggler"}'

beforeEach(() => localStorage.clear())

afterEach(() => {
  __resetSessionIdentities()
  localStorage.clear()
})

describe('a superseded incarnation cannot overwrite the session that replaced it', () => {
  it('drops a straggler write whose token predates the resume', () => {
    // The first incarnation captures a writer token, as the virtualizer and panel-tab
            // caches do before a debounced flush.
    noteLiveSessionInstances([{ key: ID, created: CREATED, incarnation: FIRST }], order(4))
    setSessionScopedItem(localStorage, KEY, OLD_VIEW)
    const tokenFromOldInstance = sessionOwnerStamp(ID)
    expect(tokenFromOldInstance).toBeDefined()

    // The session is closed and resumed under the SAME key, so `created` is unchanged and
    // only the frame counter moves on.
    noteLiveSessionInstances([{ key: ID, created: CREATED, incarnation: AFTER_RESUME }], order(9))
    setSessionScopedItem(localStorage, KEY, RESUMED_VIEW)

    // The old instance's debounced flush finally lands.
    setSessionScopedItem(localStorage, KEY, STRAGGLER_VIEW, tokenFromOldInstance)

    expect(localStorage.getItem(KEY)).toBe(RESUMED_VIEW)
  })

  it('still accepts a write from the live incarnation', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED, incarnation: AFTER_RESUME }], order(9))
    const liveToken = sessionOwnerStamp(ID)

    setSessionScopedItem(localStorage, KEY, RESUMED_VIEW, liveToken)

    expect(localStorage.getItem(KEY)).toBe(RESUMED_VIEW)
  })

  it('rejects a token whose durable stamp belongs to another session entirely', () => {
    noteLiveSessionInstances([{ key: ID, created: CREATED, incarnation: AFTER_RESUME }], order(9))

    setSessionScopedItem(localStorage, KEY, STRAGGLER_VIEW, '2020-01-01T00:00:00Z|inc-after-resume')

    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
