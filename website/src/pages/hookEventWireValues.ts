/**
 * WIRE VALUES ONLY: the lifecycle event names the hooks API accepts.
 *
 * Every entry is matched BY VALUE against the backend's `ALLOWED_HOOK_EVENTS`
 * allowlist and stored verbatim on the hook record, so a translated `AgentSpawn`
 * is rejected by the API and the picker silently stops working in that locale
 * while adding a catalog entry no one can act on. They do reach the screen as
 * picker rows, the same way the other wire-value modules' values do.
 *
 * Kept in its own module rather than exempted where it is used: the hooks page
 * carries real user-visible copy, so a file-scoped i18n exemption there would
 * silence the gate over prose it exists to catch.
 *
 * ORDER IS THE PICKER ORDER, and it drives `EVENT_ORDER` for the hooks table.
 */
export const EVENTS = [
  'AgentSpawn',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionLaneChanged',
]

/**
 * The set of lane-id characters the backend matcher accepts, mirroring its own
 * `_TOKEN_ALLOWED` allowlist. Anything else is not a lane id we can safely build a glob
 * from: a hand-edited `tags.json` carrying `*` would otherwise widen the matcher to every
 * lane, so a close-out hook would fire for sessions it was never scoped to.
 */
const LANE_ID_ALLOWED = /^[a-z0-9_-]+$/

export function isLaneIdSafe(tagId: string) {
  return LANE_ID_ALLOWED.test(tagId)
}

/**
 * The glob a lane hook needs to match one lane, built from that lane's tag id.
 *
 * Also a wire value: the backend matches `added:<id>;` inside the payload, so the
 * separators and the surrounding wildcards are protocol rather than copy and must
 * not be translated. Lives here so the page can offer lanes as one-click choices
 * instead of asking the author to hand-assemble this from an API response.
 *
 * Returns '' for an id outside the allowlist rather than emitting a glob that would
 * match lanes the author never chose. Only the `added` direction is built: nothing in the
 * UI writes `removed:`, so a direction parameter would be a knob with no caller.
 */
export function laneMatcherToken(tagId: string) {
  if (!isLaneIdSafe(tagId)) return ''
  return '*added:' + tagId + ';*'
}
