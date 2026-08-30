import { useCallback, useRef, useState } from 'react'
import { api } from '../api/client'
import { isDeadlineError } from '../api/queryClient'

export type BrowseListError = false | 'failed' | 'timeout'

type BrowseDirsResult = Awaited<ReturnType<typeof api.browseDirs>>

/**
 * The directory drill both pickers need, as a plain promise plus a generation counter.
 *
 * The deadline lives in `api.browseDirs`, so the only thing this has to add is supersession --
 * a slower earlier drill must not deliver rows over a later one -- and an error state, so a
 * bounded failure surfaces instead of being swallowed. There is no cache, so reopening re-reads
 * by construction and nothing can replay a previous drill's rows.
 *
 * `preserveInput` travels with the call rather than in a ref, so the flag the caller's success
 * path reads always belongs to the drill whose rows just arrived.
 */
export function useBrowseDirs(
  onData: (d: BrowseDirsResult, preserveInput: boolean) => void,
) {
  const [listError, setListError] = useState<BrowseListError>(false)
  const onDataRef = useRef(onData)
  onDataRef.current = onData

  const genRef = useRef(0)
  const pathRef = useRef<string | undefined>(undefined)

  const browse = useCallback((path?: string, preserveInput = false) => {
    genRef.current += 1
    const gen = genRef.current
    pathRef.current = path
    return api.browseDirs(path).then(
      d => {
        if (gen !== genRef.current) return
        setListError(false)
        onDataRef.current(d, preserveInput)
      },
      e => {
        if (gen !== genRef.current) return
        setListError(isDeadlineError(e) ? 'timeout' : 'failed')
      },
    )
  }, [])

  // The path THIS drill asked for, not the caller's state: before anything succeeds there is none.
  // Returned so the caller can hold its control busy for exactly this read's lifetime.
  const retry = useCallback(() => browse(pathRef.current, true), [browse])

  return { listError, browse, retry }
}
