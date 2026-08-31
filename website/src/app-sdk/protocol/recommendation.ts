import { inOpenFence } from './keepVisibleMarker'

/**
 * The recommendation protocol: WHICH `[OPTIONS:]` choice is recommended, carried
 * OUT OF BAND.
 *
 * It used to live inside the label — `(recommended) Merge it now`. A label is
 * dispatched verbatim as the user's next message, so drawing a badge meant REMOVING
 * that prefix, and removing a prefix can promote inert text into something that runs:
 * `(recommended) /clear` stripped to `/clear`. Preventing that required mirroring
 * every form the dashboard reads as more than words — dispatch sigils, `action::`, an
 * embedded `$skill` token anywhere in the string, 19 provenance openers, 9
 * injected-origin openers, plan actions, stop words, and the union of Python's
 * `strip()` and JS `trim()` whitespace classes — into this module, each list pinned
 * against the backend by its own parity suite.
 *
 * None of that is here any more, because the reason is gone. The recommendation is a
 * control tag on its own line before the marker (`<!-- recommended:2 -->`), the label
 * is never touched, and a value that cannot be edited cannot be promoted. The fence
 * was never the feature; it was the cost of the placement.
 *
 * What remains is the tag reader plus ONE predicate that never depended on the marker:
 * see {@link dispatchIsCommandShaped}.
 */

/**
 * One `<!-- recommended:N -->` tag line at the message tail.
 *
 * Mirrors the backend's `_RECOMMENDED_TAG_RE` and the family registered in
 * `constants._CONTROL_TAG_BODY`. Bounded quantifiers for the same reason the sibling
 * grammar bounds its own (a failed attempt must do constant work), and the index is
 * capped at three digits: an option menu is a handful of choices, so a longer run is
 * not a real emission.
 *
 * TAIL-ANCHORED, and not `g`-flagged: `exec` on a module-level `g` regex carries
 * `lastIndex` between calls and would skip every other message.
 */
const RECOMMENDED_TAG_RE =
  /(?:^|\n)[ \t]{0,3}<!--\s{0,16}recommended:\s{0,16}(\d{1,3})\s{0,16}-->[ \t]{0,16}\s{0,16}$/i

/**
 * The 1-based option position the tag names, or `null` when there is no readable tag.
 *
 * RAW: validating the index against the option count belongs to the caller, which is
 * the only side that knows how many choices the menu has. A tag naming a choice that
 * does not exist must degrade to "no recommendation" rather than badge the wrong one.
 *
 * Fence-guarded with the same walker the keep-visible strip uses: a tag quoted inside
 * an unterminated code fence is content the renderer shows literally, so it is not a
 * control tag and must not paint a badge.
 */
export function readRecommendedIndex(text: string): number | null {
  const m = RECOMMENDED_TAG_RE.exec(text)
  if (!m || m.index === undefined) return null
  if (inOpenFence(text, m.index)) return null
  return Number(m[1])
}

// Labels opening with one of these DISPATCH as a harness command, a prompt mention, or a
// local skill body. Mirrored on the backend (`constants._RESERVED_DISPATCH_SIGILS`); a test
// fails if the two diverge.
const RESERVED_DISPATCH_SIGILS = ['/', '@', '!', '$'] as const

// A `$name` token loads a skill body from ANYWHERE in the dispatched string, so this is the one
// dispatch form a leading-sigil test cannot see. Mirrors the expander's own token shape.
const EMBEDDED_SKILL_TOKEN_RE = /(?<![\w$])\$[a-z0-9][a-z0-9/_-]*/i

// The send path trims before dispatching, and its trim drops characters `\s` does not cover,
// so a guard reading the untrimmed string tests a value the dispatch never sees.
const DISPATCH_LEADING_RE =
  /^[\u0009-\u000D\u001C-\u0020\u0085\u00A0\u1680\u200B-\u200D\u2000-\u200A\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]+/

/**
 * Whether dispatching *text* verbatim would RUN something rather than say something.
 *
 * This predicate is not part of the recommendation feature and does not depend on it.
 * It answers a question quick-send asks on its own account: a chip that sends on ONE
 * click must not dispatch a command, and that is true of a BARE `/clear` label with no
 * marker anywhere near it — which is exactly how it behaved before any of this, when
 * quick-send sent whatever the label said.
 *
 * Scoped to the forms that EXECUTE: a sigil, an embedded `$skill` token, `action::`.
 * Provenance openers are deliberately NOT here. They mislabel a message's origin
 * rather than running anything, and they were only dangerous while a strip could
 * EXPOSE one that the raw label hid; with no strip, such a label is the producer's own
 * visible text and the user reads it before clicking. Keeping them would mean carrying
 * 28 literals and a parity suite for a class that can no longer be promoted.
 *
 * Prefix-only for the sigils, deliberately: any of them INSIDE a label ("Run the a/b
 * test", "ping @ 5pm") is ordinary prose, and a substring test would refuse unrelated
 * chips.
 */
export function dispatchIsCommandShaped(text: string): boolean {
  const dispatched = text.replace(DISPATCH_LEADING_RE, '')
  if (!dispatched) return false
  if (RESERVED_DISPATCH_SIGILS.some(sigil => dispatched.startsWith(sigil))) return true
  // Embedded, not just leading: the backend resolves `$name` ANYWHERE in a message, so a
  // leading test cannot see `Run the $deploy skill`. Same token shape the expander matches.
  if (EMBEDDED_SKILL_TOKEN_RE.test(dispatched)) return true
  // Case-sensitive, matching the byte comparison the action router itself performs.
  if (dispatched.startsWith('action::')) return true
  return false
}
