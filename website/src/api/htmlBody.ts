/**
 * Is this response body an HTML PAGE rather than an error message?
 *
 * Its own module because two things need it and they sit on opposite sides of an
 * import: `api/apiError` drops such a body rather than rendering it, and
 * `api/edgeAuthChallenge` treats it on a 401/403 as an interposed proxy's sign-in
 * page. Keeping one definition is what stops those two drifting into recognising
 * different things; keeping it HERE is what lets `apiError` call the challenge
 * detector without the two modules importing each other.
 */

/**
 * Anchored at the start, so a body that merely MENTIONS markup is not a page.
 * `<!doctype` needs the trailing space; `<html` accepts a space or the close, so
 * `<htmlish>` is not matched.
 */
const HTML_DOCUMENT_START = /^<(?:!doctype\s|html[\s>])/i

export const looksLikeHtmlDocument = (body: string): boolean =>
  HTML_DOCUMENT_START.test(body.trim())
