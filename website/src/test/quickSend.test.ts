import { describe, it, expect, vi } from 'vitest'
import { shouldQuickSend, tryQuickSend } from '../lib/quickSend'

describe('shouldQuickSend', () => {
  it('returns true when enabled, no shift, not running, no picks', () => {
    expect(shouldQuickSend(true, false, false, 0)).toBe(true)
  })
  it('returns false when disabled', () => {
    expect(shouldQuickSend(false, false, false, 0)).toBe(false)
  })
  it('returns false when undefined', () => {
    expect(shouldQuickSend(undefined, false, false, 0)).toBe(false)
  })
  it('returns false when shift held', () => {
    expect(shouldQuickSend(true, true, false, 0)).toBe(false)
  })
  it('returns false when slot running', () => {
    expect(shouldQuickSend(true, false, true, 0)).toBe(false)
  })
  it('returns false when items already picked', () => {
    expect(shouldQuickSend(true, false, false, 2)).toBe(false)
  })
})

describe('tryQuickSend', () => {
  it('calls send and returns true when conditions met', () => {
    const send = vi.fn()
    expect(tryQuickSend('hello', true, false, false, 0, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('hello')
  })
  it('returns false and does not send when disabled', () => {
    const send = vi.fn()
    expect(tryQuickSend('hello', false, false, false, 0, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  it('returns false when shift held', () => {
    const send = vi.fn()
    expect(tryQuickSend('hello', true, true, false, 0, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a label that merely LOOKS like a marker, because it is ordinary text now', () => {
    const send = vi.fn()
    // `(recommended)` has no protocol meaning inside a label any more -- the recommendation
    // rides in a control tag. So this label is prose that opens with a parenthetical, and a
    // click must send exactly the bytes the user read. It is not command-shaped: it opens
    // with `(`, so nothing dispatches.
    expect(tryQuickSend('(recommended) /clear', true, false, false, 0, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('(recommended) /clear')
  })

  it('refuses a label that would dispatch a command', () => {
    const send = vi.fn()
    expect(tryQuickSend('/clear', true, false, false, 0, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends an ordinary label', () => {
    const send = vi.fn()
    expect(tryQuickSend('Merge it now', true, false, false, 0, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('Merge it now')
  })
})
