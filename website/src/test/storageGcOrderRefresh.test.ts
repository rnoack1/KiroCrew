/** Storage ownership must follow the wire order, which moves without the slots array moving.
 *
 *  A snapshot identical in membership, order and row content preserves the array reference, so
 *  a reference comparison cannot see the new emission. The registry dates writes against the
 *  wire order, so a registry left behind makes the session's own writes read as stale while
 *  the ledger is dated from the newer frames.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionIdentities,
  noteLiveSessionInstances,
  setSessionScopedItem,
} from '../utils/storageGc'

const ID = 'chat-steady'
const KEY = `mc-panel-tabs:${ID}`
const EPOCH = 'gw-epoch-6'
const CREATED = '2026-05-05T05:05:05Z'
const INCARNATION = 'inc-steady'
const VALUE = '{"tab":"files"}'
const LATER = '{"tab":"activity"}'

const rows = () => [{ key: ID, created: CREATED, incarnation: INCARNATION }]
const order = (generation: number) => ({ generation, epoch: EPOCH })

const readShell = () => {
  const files = import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const entry = Object.values(files)[0]
  expect(entry, 'App.tsx was not reachable through the raw glob').toBeTruthy()
  return entry
}

beforeEach(() => localStorage.clear())

afterEach(() => {
  __resetSessionIdentities()
  localStorage.clear()
})

describe('an identical re-emission does not strand storage ownership', () => {
  it('refreshes the registry when the order moves under an unchanged array', () => {
    const shell = readShell()
    const at = shell.indexOf('noteLiveSessionInstances(next, nextOrder)')

    expect(at, 'the subscribe does not pass a re-read order').toBeGreaterThan(-1)
    const effect = shell.slice(Math.max(0, at - 700), at)
    // The reference check alone must not be able to skip the refresh.
    expect(effect).toMatch(/generation !== lastOrder\.generation/)
    expect(effect).toMatch(/epoch !== lastOrder\.epoch/)
    expect(effect).toMatch(/next === last && !orderMoved/)
  })

  it('accepts the session’s own write while the registry is current', () => {
    noteLiveSessionInstances(rows(), order(4))
    setSessionScopedItem(localStorage, KEY, VALUE)

    // The same rows re-emitted at a newer generation: the registry must move with it.
    noteLiveSessionInstances(rows(), order(9))
    setSessionScopedItem(localStorage, KEY, LATER)

    expect(localStorage.getItem(KEY)).toBe(LATER)
  })

  it('still refuses a write a genuinely newer recorded owner outranks', () => {
    noteLiveSessionInstances(rows(), order(9))
    setSessionScopedItem(localStorage, KEY, VALUE)
    localStorage.setItem(
      `mc-storage-gc-owner:${KEY}`,
      JSON.stringify({ stamp: CREATED, seenAt: Date.now(), generation: 40, epoch: EPOCH }),
    )

    setSessionScopedItem(localStorage, KEY, LATER)

    expect(localStorage.getItem(KEY)).toBe(VALUE)
  })
})
