/**
 * Hook lifecycle event names, as the backend spells them.
 *
 * These are WIRE VALUES, not copy: the API matches them by value against the
 * backend's own event allowlist, so a translated or reworded one is rejected. They
 * live here, apart from the page, so that boundary is visible in one place and
 * the i18n literal-string lint can be scoped to exactly this file.
 */
export const EVENTS = [
  'AgentSpawn',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionLaneChanged',
]

/** Glob and regex metacharacters, which stand in for characters we cannot know. */
const WILDCARDS = /[*?[\]()|+.\\^$\-{}]/g

/**
 * Can this `SessionLaneChanged` matcher never match any tag id?
 *
 * The charset is the backend validator's own, `[a-z0-9_-]+`, so a seeded lane id (`done`,
 * `todo`, `review`, `planned`, `implementation`) is exactly as valid as a generated hex one
 * and must NOT be condemned. Hyphen is absent from the test below only because it is a glob
 * metacharacter, so it is already stripped as a wildcard before we look.
 *
 * CASE IS IRRELEVANT, and getting that wrong is what this comment exists to prevent: the
 * backend matches with `fnmatch(context.lower(), matcher.lower())`, lowercasing BOTH sides, so
 * `*added:Done;*` fires exactly as `*added:done;*` does. The literal is therefore folded before
 * the charset test, and only a character no id may hold AT ANY CASE — a space, punctuation —
 * condemns a term.
 *
 * The matcher context spells each id as `added:<id>;` / `removed:<id>;`, so two shapes fire on
 * nothing and both save without complaint: one with no direction-tagged term at all, and one
 * whose term spells something outside the charset. Wildcards stand in for unknown characters,
 * so a term is only condemned on what it spells literally.
 */
export function matcherCannotMatchAnyTagId(matcher: string): boolean {
  const text = matcher.trim()
  if (text === '') return false

  // `:<id>;` with no direction word is the spec's "any movement" selector, so the direction
  // is optional -- but the trailing `;` is NOT required, or a trailing wildcard drops the term.
  const terms = [...text.matchAll(/(?:added|removed)?:([^;]*)/g)]
  if (terms.length === 0) return true

  return terms.some(([, idPart]) => {
    const literal = idPart.replace(WILDCARDS, '').toLowerCase()
    return literal !== '' && /[^a-z0-9_]/.test(literal)
  })
}
