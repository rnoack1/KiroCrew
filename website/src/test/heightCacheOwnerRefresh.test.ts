/** A long-lived cache must date each flush by the instance that is live when it writes.
 *
 *  A gateway restart rebuilds the slot object with a new incarnation under the same `created`,
 *  so an owner token taken in the constructor dates every later write to an instance that no
 *  longer exists, and the write is refused for the rest of the cache's life.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeightCache } from '../hooks/virtualizer/HeightCache'
import { __resetSessionIdentities, noteLiveSessionInstances } from '../utils/storageGc'

const ID = 'chat-restarted'
const EPOCH_BEFORE = 'gw-epoch-before'
const EPOCH_AFTER = 'gw-epoch-after'
const CREATED = '2026-05-05T05:05:05Z'

const rows = (incarnation: string) => [{ key: ID, created: CREATED, incarnation }]
const stored = () => localStorage.getItem(`vc_heights_${ID}`)

beforeEach(() => localStorage.clear())

afterEach(() => {
  __resetSessionIdentities()
  localStorage.clear()
})

describe('the height cache survives a gateway restart', () => {
  it('flushes after the slot object is rebuilt with a new incarnation', () => {
    noteLiveSessionInstances(rows('inc-before'), { generation: 4, epoch: EPOCH_BEFORE })
    const cache = new HeightCache(ID, { rowCount: 3 })

    // The gateway restarts: same durable identity, new incarnation and epoch.
    noteLiveSessionInstances(rows('inc-after'), { generation: 1, epoch: EPOCH_AFTER })

    cache.set('row-1', 42)
    cache.flush()

    expect(stored(), 'the rebuilt instance could not write its own heights').not.toBeNull()
  })

  it('does not cache an owner token on the instance', () => {
    const files = import.meta.glob('../hooks/virtualizer/HeightCache.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const source = Object.values(files)[0]
    expect(source, 'HeightCache.ts was not reachable through the raw glob').toBeTruthy()

    // Positive control: the module really does stamp its writes.
    expect(source).toMatch(/setSessionScopedItem\(/)
    expect(source).not.toMatch(/private readonly owner/)
    expect(source).toMatch(/currentOwner\(\)/)
  })
})
