/** Proof of survival must retire the wait-and-see prohibition, not leave it contradicting the list. */

import { describe, it, expect } from 'vitest'
import reducer, { setSessionCloseFailure, slotsSnapshotApplied } from '../store/chatSlice'

const INCARNATION = 'inc-7'

const withUnknownNotice = () =>
  reducer(
    undefined,
    setSessionCloseFailure({
      kind: 'unknown',
      key: 'chat-9',
      title: 'Draft',
      incarnation: INCARNATION,
    }),
  )

describe('an unknown close settles when the session is proven still open', () => {
  it('becomes the refused variant when the row returns at the closing instance', () => {
    const state = withUnknownNotice()

    const next = reducer(
      state,
      slotsSnapshotApplied([{ key: 'chat-9', incarnation: INCARNATION, closing: false }]),
    )

    expect(next.sessionCloseFailure?.kind).toBe('refused')
    expect(next.sessionCloseFailure?.title).toBe('Draft')
  })

  it('stays unknown while the row is still marked closing', () => {
    const state = withUnknownNotice()

    const next = reducer(
      state,
      slotsSnapshotApplied([{ key: 'chat-9', incarnation: INCARNATION, closing: true }]),
    )

    expect(next.sessionCloseFailure?.kind).toBe('unknown')
  })

  it('stays unknown when a DIFFERENT instance holds the key', () => {
    const state = withUnknownNotice()

    const next = reducer(
      state,
      slotsSnapshotApplied([{ key: 'chat-9', incarnation: 'inc-9', closing: false }]),
    )

    expect(next.sessionCloseFailure?.kind).toBe('unknown')
  })

  it('still confirms when the key is omitted altogether', () => {
    const state = withUnknownNotice()

    const next = reducer(state, slotsSnapshotApplied([{ key: 'chat-other' }]))

    expect(next.sessionCloseFailure?.kind).toBe('confirmed')
  })
})
