/**
 * SCOPE BOUNDARY: a per-endpoint deadline is for a fetch the user waits on where an
 * unsettled promise is indistinguishable from an empty result AND the surface behind it
 * names a timeout apart from a failure in its own copy. That second half is the real
 * limit: a consumer rendering the server's message verbatim would surface this
 * rejection's untranslated `deadline exceeded` in every locale, trading a spinner for a
 * worse bug -- which is why the git panel and the knowledge search stay unbounded.
 *
 * Scope, measured rather than asserted: the API client declares 149 `fetch('/api/...`
 * sites and this bounds FIVE -- the file search plus the four directory and tree listings
 * behind the same symptom. That ratio is the argument for the general bound, which a
 * per-endpoint constant cannot reach. Do not add one past that set; the general bound
 * belongs in the shared transport, and when it lands these constants are RETIRED.
 */

/** An `Error` and not a `DOMException`, which the abort reason would otherwise be:
 *  the i18n gate exempts `Error` as a diagnostic callee, `DOMException` it reports. */
function timeoutReason(): Error {
  const e = new Error('deadline exceeded')
  e.name = 'TimeoutError'
  return e
}

/** Run `attempt` under a deadline, rejecting with TimeoutError if it has not
 *  settled in `ms`. Relays `outer` (react-query's unmount/cancel signal) and
 *  releases both the timer and the relay listener once settled.
 *
 *  Not `AbortSignal.timeout` + `AbortSignal.any`: the former exposes no handle
 *  so its timer cannot be released, and the latter's browser floor sits well
 *  above the rest of this codebase's. See the CR description. */
export function withDeadline<T>(
  ms: number,
  outer: AbortSignal | undefined,
  attempt: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(timeoutReason()), ms)
  const relay = () => ac.abort(outer?.reason)
  // A listener added to an already-aborted signal never fires, so we would
  // otherwise sit out the full deadline on an abandoned request.
  if (outer?.aborted) ac.abort(outer.reason)
  else outer?.addEventListener('abort', relay, { once: true })

  const release = () => {
    clearTimeout(timer)
    outer?.removeEventListener('abort', relay)
  }
  try {
    return attempt(ac.signal).finally(release)
  } catch (e) {
    release()   // a synchronous throw never reaches the `finally` above
    throw e
  }
}
