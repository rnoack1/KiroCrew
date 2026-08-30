import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { api } from '../api/client'
import { useBrowseDirs } from '../components/useBrowseDirs'

type Dirs = Awaited<ReturnType<typeof api.browseDirs>>

const dirs = (...names: string[]): Dirs =>
  ({ dirs: names.map(n => '/root/' + n) }) as unknown as Dirs

beforeEach(() => { vi.restoreAllMocks() })

describe('useBrowseDirs delivery', () => {
  it('serves a reopened drill the current directory, not the rows it showed last time', async () => {
    const onData = vi.fn()
    vi.spyOn(api, 'browseDirs')
      .mockResolvedValueOnce(dirs('alpha'))
      .mockResolvedValueOnce(dirs('alpha', 'brand-new'))
    const { result } = renderHook(() => useBrowseDirs(onData))

    await act(async () => { await result.current.browse() })
    expect(onData.mock.calls[0][0]).toEqual(dirs('alpha'))

    // Reopening re-reads: a directory created between the two opens must be visible.
    await act(async () => { await result.current.browse() })
    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData.mock.calls[1][0]).toEqual(dirs('alpha', 'brand-new'))
  })

  it('drops a superseded drill rather than delivering its rows over the later one', async () => {
    const onData = vi.fn()
    let releaseSlow: (d: Dirs) => void = () => {}
    vi.spyOn(api, 'browseDirs')
      .mockReturnValueOnce(new Promise<Dirs>(r => { releaseSlow = r }))
      .mockResolvedValueOnce(dirs('second'))
    const { result } = renderHook(() => useBrowseDirs(onData))

    let slow: Promise<void> | undefined
    act(() => { slow = result.current.browse('/root/slow') })
    await act(async () => { await result.current.browse('/root/second') })
    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData.mock.calls[0][0]).toEqual(dirs('second'))

    // The first drill lands LAST. Without the generation check it would overwrite the rows the
    // user is actually looking at.
    await act(async () => { releaseSlow(dirs('slow')); await slow })
    expect(onData).toHaveBeenCalledTimes(1)
  })

  it('retry re-reads the path that failed, with no successful drill to fall back on', async () => {
    const onData = vi.fn()
    const spy = vi.spyOn(api, 'browseDirs')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(dirs('recovered'))
    const { result } = renderHook(() => useBrowseDirs(onData))

    // A SUBDIRECTORY, not the root: browsing the root leaves the remembered path undefined, so a
    // retry that forgot it would read the same thing by accident and the test could not tell.
    await act(async () => { await result.current.browse('/root/deep') })
    await waitFor(() => expect(result.current.listError).toBe('failed'))
    expect(onData).not.toHaveBeenCalled()

    await act(async () => { await result.current.retry() })
    await waitFor(() => expect(result.current.listError).toBe(false))
    expect(spy.mock.calls[1][0]).toBe('/root/deep')
    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData.mock.calls[0][1]).toBe(true)
  })

  it('drops a superseded drill that FAILS instead of painting a notice over newer rows', async () => {
    const onData = vi.fn()
    let rejectSlow: (e: Error) => void = () => {}
    vi.spyOn(api, 'browseDirs')
      .mockReturnValueOnce(new Promise<Dirs>((_, rej) => { rejectSlow = rej }))
      .mockResolvedValueOnce(dirs('second'))
    const { result } = renderHook(() => useBrowseDirs(onData))

    let slow: Promise<void> | undefined
    act(() => { slow = result.current.browse('/root/slow') })
    await act(async () => { await result.current.browse('/root/second') })
    expect(result.current.listError).toBe(false)

    await act(async () => { rejectSlow(new Error('too late')); await slow })
    // The rows on screen are the second drill's. A failure notice here would blank them.
    expect(result.current.listError).toBe(false)
    expect(onData).toHaveBeenCalledTimes(1)
  })

  it('names a deadline failure apart from any other failure', async () => {
    vi.spyOn(api, 'browseDirs').mockRejectedValue(
      Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError' }))
    const { result } = renderHook(() => useBrowseDirs(vi.fn()))
    await act(async () => { await result.current.browse() })
    await waitFor(() => expect(result.current.listError).toBe('timeout'))
  })
})
