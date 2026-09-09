import { describe, expect, it, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { pinnedMarkerListener } from '../store/pinnedMarkerOwner'
import { fetchSlots } from '../store/dashboardSlice'
import {
  PINNED_SESSION_ORDER_KEY,
  PINNED_SESSION_ORDER_MANUAL_KEY,
  markPinnedSessionOrderManual,
  readPinnedSessionOrderIsManual,
} from '../utils/pinnedSessionOrder'
import { publishPinMutationKeysInFlight } from '../utils/pinMutationsInFlight'

function store() {
  return configureStore({
    reducer: { dashboard: (state = { slotsLoaded: true }) => state },
    middleware: getDefault => getDefault().prepend(pinnedMarkerListener.middleware),
  })
}

/** The reply the request would have produced: the pins did not exist when it was issued. */
const prePinFrame = [{ key: 'a', pinned: false }, { key: 'b', pinned: false }]

describe('a fetch reply that pre-dates the arrangement it would discard', () => {
  beforeEach(() => {
    localStorage.clear()
    publishPinMutationKeysInFlight([])
  })

  it('keeps an arrangement stated after the request was dispatched, once the pin has reconciled', () => {
    const s = store()
    const requestId = 'req-out-of-order'

    // The zero-pin fetch is dispatched first, so its reply cannot have seen what follows.
    s.dispatch({ type: fetchSlots.pending.type, meta: { requestId, arg: undefined } })

    // The user pins and reorders, and the pin then fully reconciles, so the in-flight record — the
    // only guard before this fix — is empty by the time the stale reply arrives.
    localStorage.setItem(PINNED_SESSION_ORDER_KEY, JSON.stringify(['b', 'a']))
    markPinnedSessionOrderManual()
    publishPinMutationKeysInFlight([])
    expect(readPinnedSessionOrderIsManual()).toBe(true)

    s.dispatch({
      type: fetchSlots.fulfilled.type,
      payload: prePinFrame,
      meta: { requestId, arg: undefined, requestStatus: 'fulfilled' },
    })

    expect(localStorage.getItem(PINNED_SESSION_ORDER_MANUAL_KEY)).toBe('1')
    expect(readPinnedSessionOrderIsManual()).toBe(true)
  })

  it('still settles a reply dispatched after the arrangement, so an unpin to zero is not ignored', () => {
    const s = store()
    const requestId = 'req-in-order'

    localStorage.setItem(PINNED_SESSION_ORDER_KEY, JSON.stringify(['b', 'a']))
    markPinnedSessionOrderManual()

    // Dispatched after the statement, so this reply genuinely reflects the arrangement's own world.
    s.dispatch({ type: fetchSlots.pending.type, meta: { requestId, arg: undefined } })
    s.dispatch({
      type: fetchSlots.fulfilled.type,
      payload: prePinFrame,
      meta: { requestId, arg: undefined, requestStatus: 'fulfilled' },
    })

    expect(readPinnedSessionOrderIsManual()).toBe(false)
  })

  it('refuses a reply it cannot date, so an unstamped fulfilment cannot discard the arrangement', () => {
    const s = store()

    localStorage.setItem(PINNED_SESSION_ORDER_KEY, JSON.stringify(['b', 'a']))
    markPinnedSessionOrderManual()

    s.dispatch({
      type: fetchSlots.fulfilled.type,
      payload: prePinFrame,
      meta: { requestId: 'never-pended', arg: undefined, requestStatus: 'fulfilled' },
    })

    expect(readPinnedSessionOrderIsManual()).toBe(true)
  })
})
