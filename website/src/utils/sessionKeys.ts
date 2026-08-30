/**
 * Recognising a dashboard chat session by its identifier: text → slot key, for
 * the two shapes the key arrives in.
 *
 * Dependency-free (no React, no DOM) so both call sites in `MarkdownRenderer`
 * share ONE grammar and cannot drift — a key accepted as an inline chip is
 * accepted as a link, or neither is.
 */

/** Base for resolving a root-relative href. Never used as an origin: the caller
 *  has already rejected anything that could carry one (see `sessionKeyFromChatHref`),
 *  so this only exists because `new URL` demands a base. */
const RELATIVE_BASE = 'http://localhost'

/**
 * A slot key as the backend mints it: `chat-<n>-<unix-ts>`.
 *
 * The `dashboard_` prefix is accepted and stripped because that is the RESUMED
 * spelling — history files are named `dashboard_chat-<n>-<ts>.jsonl`, so an agent
 * that learned the key by listing transcripts writes the prefixed form while one
 * reading the live roster writes the bare form. Both name the same session, and
 * only the bare form is a slot key, so normalise here rather than leaving each
 * call site to remember.
 *
 * Anchored at both ends: a key is the WHOLE span, never a substring of it.
 * Matching loosely would turn any prose mentioning a key into a chip whose text
 * and target disagree.
 */
const SESSION_KEY_RE = /^(?:dashboard_)?(chat-\d+-\d+)$/

/** The slot key `raw` names, or null. Surrounding whitespace is trimmed; nothing
 *  else about the span is tolerated. */
export function sessionKeyFrom(raw: string): string | null {
  const match = SESSION_KEY_RE.exec(raw.trim())
  return match ? match[1] : null
}

/**
 * The slot key a chat deep link points at, or null.
 *
 * Root-relative hrefs ONLY. An absolute URL is refused even when its path would
 * match, because a session chip's whole promise is that activating it stays
 * inside this dashboard — honouring `https://elsewhere.example/chat?sid=x` would
 * silently retarget that promise at another origin. `//host/chat?sid=x` is
 * refused for the same reason: a leading double slash is protocol-relative, so
 * it reads as a local path but resolves to a foreign host.
 *
 * Accepts `?sid=` and the legacy `?slot=` alias, matching what `ChatPage` itself
 * reads, and tolerates the optional title slug in `/chat/<slug>` since the slug
 * is cosmetic and the key rides in the query either way.
 */
export function sessionKeyFromChatHref(href: string): string | null {
  if (!href.startsWith('/') || href.startsWith('//')) return null
  let url: URL
  try {
    url = new URL(href, RELATIVE_BASE)
  } catch {
    return null
  }
  if (url.pathname !== '/chat' && !url.pathname.startsWith('/chat/')) return null
  const sid = url.searchParams.get('sid') ?? url.searchParams.get('slot')
  return sid ? sessionKeyFrom(sid) : null
}
