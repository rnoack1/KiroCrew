/**
 * `(recommended)` inside an option label is PROTOCOL, not label text.
 *
 * The dashboard's injected option-label rules instruct the agent to emit the
 * marker (`_OPTIONS_RECOMMENDED_RULE`, backend side), and only the dashboard
 * receives that rule. This grammar still RECOGNISES the marker rather than
 * requiring it: an unmarked label is valid and costs nothing.
 *
 * Recognising it matters because of where it lands. The label renders inside
 * `ChipLabel`'s single clamped line, and a label long enough to be worth a
 * recommendation is long enough to be clamped, so the ellipsis reaches the marker
 * and the recommendation is the part that disappears.
 * The recommendation then exists in the message text and nowhere the user can
 * see it, and the only way to read it is to click each chip in turn to spill its
 * full text into the composer — which is the menu defeating itself.
 *
 * Splitting it out lets the renderer place the marker OUTSIDE the clamped span,
 * where no label length can hide it, and keeps the chip one line tall.
 *
 * It also fixes what the click sends. The label doubles as the user's next
 * message, and "(recommended) Merge it now" is not a sentence the user wrote —
 * the recommendation was the agent's. Stripping it here means every surface
 * sends the instruction and only the instruction.
 */

/**
 * The marker, in the one form that has a producer: `(recommended)`.
 *
 * Deliberately narrow, and this bounds UI copy rather than just parsing. Admitting
 * a marker is what paints a badge, so an open trailing word would let
 * `(recommended strongly)` style itself as a recommendation, and an open-ended
 * `\(([^)]*)\)` would do the same for any parenthetical in a label — "(see below)",
 * "(destructive)". The badge word itself is a constant in `ChipBadge`; this grammar
 * decides only WHETHER a label carries the marker.
 *
 * Ordering variants (`(recommended first)` / `(recommended then)`) are NOT
 * admitted: nothing in this repo emits them. Re-admit the day one is observed.
 *
 * EDGES ONLY, and this is a correctness boundary rather than a style choice. A
 * label is dispatched verbatim as the user's next message, so anything removed
 * from its interior is a word the user did not choose to drop: an unanchored
 * pattern turns `Search for the literal (recommended) token` into `Search for
 * the literal token`, silently changing what gets sent. A marker is a wrapper
 * around the instruction, so it can only sit before it or after it — text in the
 * middle is part of the instruction and is left exactly where it is.
 *
 * Two anchored patterns rather than one alternation: a single regex would need
 * two capture groups for the same concept, and the caller would have to guess
 * which one matched.
 *
 * Neither is global: these are used with `exec`, and a `g` flag would carry
 * `lastIndex` between calls on a module-level regex and skip every other label.
 */
const RECOMMENDED_LEADING_RE = /^\s*\(recommended\)/i
const RECOMMENDED_TRAILING_RE = /\(recommended\)\s*$/i

// Labels opening with one of these DISPATCH as a harness command, a prompt mention, or
// reserved provenance. Mirrored on the backend; a test fails if the two lists diverge.
const RESERVED_DISPATCH_SIGILS = ['/', '@', '['] as const

export interface SplitRecommendation {
  /** The label with the marker removed — what a click sends. */
  label: string
  /** Whether the label carried the marker. A boolean, not the marker's text:
   *  the grammar admits one spelling and `ChipBadge` holds the word, so there is
   *  no second value a caller could ever read here. */
  hasMarker: boolean
}

/**
 * Split an option label into the instruction and its recommendation marker.
 *
 * Returns the label unchanged when there is no marker, so this is safe to run
 * over every option.
 */
export function splitRecommendation(option: string): SplitRecommendation {
  // Leading first, then trailing. A label cannot be both without the marker
  // being the whole label, which the empty-label guard below rejects anyway.
  const leading = RECOMMENDED_LEADING_RE.exec(option)
  const match = leading ?? RECOMMENDED_TRAILING_RE.exec(option)
  if (!match) return { label: option, hasMarker: false }

  const head = option.slice(0, match.index)
  const tail = option.slice(match.index + match[0].length)

  // Trim only the edge the marker was removed from, never the label's interior.
  //
  // Whitespace inside a label is significant and must survive byte-for-byte:
  // the label is dispatched verbatim as the user's message, so a label like
  // `Run printf 'a  b'` carries a double space that changes what the command
  // does. Because the marker is anchored to an edge, exactly one of `head` and
  // `tail` is non-empty, so this only ever trims the outside.
  const label = `${head.trimEnd()}${tail.trimStart()}`.trim()

  // A label that was ONLY the marker keeps its original text. A badge names no
  // action, so stripping here would render a chip the user cannot interpret and,
  // worse, send an empty message. Treating it as unmarked is the safe reading of
  // a label that carries no instruction.
  if (!label) return { label: option, hasMarker: false }

  // A label that a click would DISPATCH as something other than the user's own words is left
  // exactly as it arrived.
  //
  // This is a security boundary, not a nicety. The label is sent verbatim as the user's next
  // message, and the dashboard reads THREE leading forms as more than plain text:
  //
  //   `/`  a leading-slash first word is forwarded to the harness as a command
  //        (`is_harness_slash_command`: any member of its known set — all of which begin with `/`
  //        — or, under claude_code, any leading slash at all). `(recommended) /clear` would leave
  //        here as `/clear` and erase the transcript.
  //   `@`  a message starting with `@` is run through `_expand_prompt_mention`, which resolves
  //        `@name` to a stored prompt and substitutes its CONTENT for the message. So
  //        `(recommended) @deploy` would leave here as `@deploy` and execute that prompt instead
  //        of sending the words the user saw.
  //   `[`  a leading bracket opens a reserved provenance prefix — synthesis, cron notification,
  //        subagent completion, monitor wake, hook continuation — byte-matched with no origin check.
  //
  // In every case stripping a front marker PROMOTES inert text into something that runs, or that
  // claims an origin it does not have: the raw option begins with `(`, so no path fires first. A
  // marker is presentation; it must never decide what runs.
  //
  // Returning the ORIGINAL text — rather than a stripped label plus a suppressed badge — is what
  // makes the property provable: for any label that is or would become a command, this function is
  // a no-op, so the behaviour is identical to not having the feature at all and no dispatch path
  // exists here that did not already exist upstream. Reporting no recommendation also keeps the
  // badge off, since the caller only records a marker when one is returned.
  //
  // Prefix-only, deliberately: any of these INSIDE a label ("Run the a/b test", "ping @ 5pm",
  // "the [SYSTEM] log") is ordinary prose, and a substring test would silently drop badges from
  // unrelated labels.
  if (RESERVED_DISPATCH_SIGILS.some(sigil => label.startsWith(sigil))) {
    return { label: option, hasMarker: false }
  }

  return { label, hasMarker: true }
}
