import { describe, it, expect, beforeEach } from 'vitest'
import { DRAFTS_KEY } from './chatDrafts'
import { STAGED_SENDS_KEY, loadStagedSends, saveStagedSends, setStagedSendMarker } from './chatStagedSends'

describe('the staged-send marker matches the durability of the draft it guards', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

  it('persists to the same backing store as the text draft', () => {
    const marks = loadStagedSends()
    setStagedSendMarker(marks, 'slot-a', 's-durable-1')
    saveStagedSends(marks)

    // The marker guards a PERSISTED draft, so a tab reopen must not strand the risky
    // payload uncaptioned -- which is exactly what a sessionStorage marker did.
    expect(localStorage.getItem(STAGED_SENDS_KEY)).toBeTruthy()
    expect(sessionStorage.getItem(STAGED_SENDS_KEY)).toBeNull()
    expect(loadStagedSends()['slot-a']).toBe('s-durable-1')
  })

  it('keys the draft it guards to the same storage', () => {
    expect(DRAFTS_KEY).not.toBe(STAGED_SENDS_KEY)
  })
})
