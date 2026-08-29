/**
 * Which unsent work another window can recover, and which it cannot.
 *
 * The claim TTL keys on this answer: recoverable work expires on the refresh scale because a
 * persisted copy still answers afterwards, while unrecoverable work earns the long bound
 * because the claim is the only record. Answering "recoverable" wrongly is therefore a
 * data-loss bug — a frozen pane's draft ages out and another window deletes the slot.
 *
 * Two things decide it independently: whether the KIND has a shared-storage representation,
 * and whether THIS host actually writes one.
 */
import { describe, expect, it } from 'vitest'

import { hasUnrecoverableComposerWork, workIsCrossWindowRecoverable } from '../utils/composerWork'

const NONE = {
  knowledge: false,
  uploading: false,
  voiceCapture: false,
  files: [] as unknown[],
  sessionRefs: [] as unknown[],
}

describe('work kinds another window cannot answer for', () => {
  it('counts a staged FILE as unrecoverable, because that store is per-tab', () => {
    // `chatFileDrafts` is sessionStorage-backed, so another window reads nothing there.
    expect(hasUnrecoverableComposerWork({ ...NONE, files: ['tok-1'] })).toBe(true)
  })

  it('counts a staged SESSION REFERENCE as unrecoverable, for the same reason', () => {
    expect(hasUnrecoverableComposerWork({ ...NONE, sessionRefs: [{ key: 'chat-x' }] })).toBe(true)
  })

  it('still counts the three kinds nothing stores at all', () => {
    expect(hasUnrecoverableComposerWork({ ...NONE, knowledge: true })).toBe(true)
    expect(hasUnrecoverableComposerWork({ ...NONE, uploading: true })).toBe(true)
    expect(hasUnrecoverableComposerWork({ ...NONE, voiceCapture: true })).toBe(true)
  })

  it('leaves plain text out of it, since that store IS shared', () => {
    // The discriminating negative: if every kind were unrecoverable the long bound would
    // apply to everything and the short TTL would be dead code.
    expect(hasUnrecoverableComposerWork(NONE)).toBe(false)
  })
})

describe('a host must declare that it persists where other windows can read', () => {
  it('treats an UNDECLARED host as storing nothing', () => {
    // The protective default. An embedded pane keeps its composer in component state and
    // writes no draft, so its text is no more recoverable than a live recording.
    expect(workIsCrossWindowRecoverable(NONE, undefined)).toBe(false)
    expect(workIsCrossWindowRecoverable(NONE, false)).toBe(false)
  })

  it('accepts a declared host for a kind the shared store holds', () => {
    expect(workIsCrossWindowRecoverable(NONE, true)).toBe(true)
  })

  it('still refuses a per-tab kind even from a declared host', () => {
    // Both conditions are required: the page persists text, but not attachments.
    expect(workIsCrossWindowRecoverable({ ...NONE, files: ['tok-1'] }, true)).toBe(false)
  })
})
