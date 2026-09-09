/**
 * Recognise an interposed gate's refusal on a failed API call.
 *
 * A gate in front of the gateway answers a lapsed session with its own HTML page and
 * no `Location` header, so the refusal arrives looking like a plain 403 whose body is
 * markup. That is the silent failure this module ends: the caller words a message off
 * the outcome below, and the reader signs in themselves.
 *
 * It deliberately does NOT try to tell a lapsed session from a firewall block. An
 * earlier revision did, scanning the body for anchors, form actions, password fields,
 * meta refreshes and `location=` assignments, and review found FOUR separate classes
 * of page it read backwards -- `/authors/jane` as a sign-in link, `/oauth2/start` as
 * not one, a form-rendered gate as a block, and a geo-block's visible `Location = US`
 * text as a redirect. Each fix was one more spelling on a hand-maintained list read
 * against a body the far side authors. The message below is honest for both cases and
 * names the same action either way, so the distinction bought wording it did not need
 * and a confidence it could not support.
 *
 * Nothing here reads the body's contents at all now: only that it IS a document.
 */
import { looksLikeHtmlDocument } from './htmlBody'
import { i18nT } from '../i18n/t'
import { isEmbeddedPane } from '../lib/embedded'

/** The statuses an auth refusal arrives with. 403 is the one measured; 401 is the
 *  canonical challenge status, and the HTML-document test is what excludes ours. */
const CHALLENGE_STATUSES: ReadonlySet<number> = new Set([401, 403])

/**
 * Whether this failed response is an interposed gate's page rather than the gateway's.
 *
 * All three signals are required; any one alone also matches a gateway denial. 401 is
 * accepted beside the measured 403 because it is the CANONICAL status for an auth
 * challenge. The gateway's own 401 is unaffected: its sinks answer JSON or plain text,
 * and an HTML DOCUMENT body is still required here.
 */
function isEdgeAuthChallenge(
  status: number,
  contentType: string | null,
  body: string,
): boolean {
  if (!CHALLENGE_STATUSES.has(status)) return false
  const type = (contentType ?? '').split(';', 1)[0].trim().toLowerCase()
  if (type !== 'text/html' && type !== 'application/xhtml+xml') return false
  return looksLikeHtmlDocument(body)
}

/**
 * What the response turned out to be; the caller words its message off this.
 *
 * `framed` is separate because it rests on a fact about THIS document rather than on a
 * reading of the far side's: a nested pane cannot complete a sign-in inside itself, so
 * "reload this tab" is the one remedy that is wrong there.
 */
export type ChallengeOutcome = 'challenged' | 'framed'

/**
 * Name an interposed gate's refusal on a failed response, or null when this response
 * is not one.
 *
 * Only ADDS a name; the caller's `ApiError` is thrown either way.
 */
export function noteEdgeAuthChallenge(
  status: number,
  contentType: string | null,
  body: string,
): ChallengeOutcome | null {
  if (!isEdgeAuthChallenge(status, contentType, body)) return null
  if (typeof window === 'undefined') return 'challenged'
  return isEmbeddedPane() ? 'framed' : 'challenged'
}

/**
 * The origin this message names, or null if it is not the one message that names one.
 *
 * The framed refusal is the ONLY string in any catalogue that carries an address
 * (`{{origin}}`); the sole other use of that placeholder names a template, not a URL.
 * Keying on the produced message rather than scanning arbitrary error text for an
 * origin keeps that knowledge here, with the producer -- so no render surface decides
 * what is linkable, and a message the far side authored can never become a link
 * however it is worded.
 */
export function addressNamedByMessage(message: string): string | null {
  try {
    // Inside the guard because producing the framed message reads the origin as well,
    // so a document that refuses to answer throws here rather than below.
    if (edgeChallengeMessage('framed') !== message) return null
    const origin = window.location.origin
    return origin && origin !== 'null' ? origin : null
  } catch {
    return null
  }
}

/**
 * The message for an outcome, or null when the response was not a challenge.
 *
 * One mapping, used by both error factories. `api/client` and `api/apiError` each
 * build an `ApiError` for the same refusal, and a second copy of this would let the
 * dashboard and the app bundles word the identical failure differently.
 *
 * Both strings offer the lapse as a CONDITION the reader can settle in one action,
 * rather than as a diagnosis this module is in no position to make.
 */
export function edgeChallengeMessage(outcome: ChallengeOutcome | null): string | null {
  if (outcome === null) return null
  if (outcome === 'framed') {
    return i18nT('api.client.proxy_challenge_framed', {
      // Origin only, and the pane's own: its address bar holds the OUTER
      // dashboard's URL, and an iframe src can carry query parameters.
      origin: typeof window === 'undefined' ? '' : window.location.origin,
    })
  }
  return i18nT('api.client.proxy_challenge_reload')
}
