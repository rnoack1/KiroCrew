/**
 * Screenshot harness + behaviour check for the `SessionLaneChanged` hook event.
 *
 * TWO frames, which are the two the Screenshot Evidence gate and the UX lane name:
 *
 *   1. the event picker OPEN, showing `SessionLaneChanged` as a sixth lifecycle option
 *      glossed "board column" — without that entry the event is registrable only
 *      through the API and the feature is unreachable from the dashboard;
 *   2. the hooks table rendering a `SessionLaneChanged` row, so the new event pill and
 *      its accent styling are visible beside a pre-existing event for contrast.
 *
 * It ASSERTS as well as photographs: each scene exits non-zero unless the thing it
 * claims to show actually rendered, so a silent regression cannot produce a passing
 * capture. Labels come from the CATALOG, so a key rename breaks this loudly rather than
 * photographing the wrong element. Nothing in CI runs this file — the CI-enforced
 * halves are HooksPage.eventPicker.test.tsx and the UI/backend parity test.
 *
 * Drives the isolated capture entry over the vite DEV server rather than a built dist:
 * this checkout cannot run `vite build` (an unrelated optional dependency is absent from
 * node_modules), and the dev server does not need it.
 *
 * Usage: node scripts/capture-session-lane-changed-hook.mjs [outDir] [baseUrl]
 *   The dev server must already be serving: npx vite --host 127.0.0.1 --port 5199
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

// Same default as every sibling harness: these frames are committed evidence under
// temp-screenshots/, which the Screenshot Evidence gate reads. Override with argv[2].
const OUT = process.argv[2] || '../temp-screenshots/session-lane-changed-hook'
const BASE = process.argv[3] || 'http://127.0.0.1:5199'
const PAGE = `${BASE}/capture/session-lane-changed-hook.html?theme=dark`

mkdirSync(OUT, { recursive: true })

const LOCALES = fileURLToPath(new URL('../src/i18n/locales/', import.meta.url))
// Keys are split across the hand-maintained catalog and the extracted one, so read both
// rather than assuming which file owns a given label.
const pageKeys = ['en.manual.json', 'en.json'].reduce((acc, f) => ({
  ...JSON.parse(readFileSync(LOCALES + f, 'utf-8')).pages.hooksPage,
  ...acc,
}), {})
const GLOSS = pageKeys.matcher_lane_pill_gloss
const EVENT_LABEL = pageKeys.event
if (!GLOSS) throw new Error('catalog key matcher_lane_pill_gloss missing — renamed?')
if (!EVENT_LABEL) throw new Error('catalog key event missing — renamed?')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
const problems = []
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
page.on('console', m => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`)
})

const failures = []

await page.goto(PAGE, { waitUntil: 'domcontentloaded' })

// ---- frame 1: the table, which is the landing state ------------------------
// The pill carries the bare wire value: the gloss rides on the PICKER option, not here.
const pill = page.getByText('SessionLaneChanged', { exact: true }).first()
await pill.waitFor({ state: 'visible', timeout: 15000 })
const pillClass = await pill.evaluate(el => el.className)
if (!/accent/.test(pillClass)) {
  failures.push(`frame 1: the pill is not accent-styled: ${JSON.stringify(pillClass)}`)
}
const comparator = page.getByText('PreToolUse', { exact: true }).first()
if ((await comparator.count()) === 0) {
  failures.push('frame 1: no pre-existing event pill in shot, so the new one stands alone')
}
await page.screenshot({ path: `${OUT}/1-hooks-table-session-lane-changed-pill.png` })

// ---- frame 2: the picker open, all six events ------------------------------
await page.getByRole('button', { name: '+ New Hook' }).click()
await page.getByLabel(EVENT_LABEL).click()
const options = page.getByRole('option')
await options.first().waitFor({ state: 'visible', timeout: 15000 })
// `visible` fires as the menu STARTS its fade-in, so shooting here catches a translucent
// panel with the form showing through it. Settle first, then assert the panel is opaque.
await page.waitForTimeout(400)
const menuOpacity = await options.first().evaluate(el => {
  const panel = el.closest('[role="listbox"]') ?? el.parentElement
  return panel ? getComputedStyle(panel).opacity : '0'
})
if (Number(menuOpacity) < 0.99) {
  failures.push(`frame 2: menu captured mid-animation at opacity ${menuOpacity}`)
}
const labels = await options.allTextContents()
if (labels.length !== 6) {
  failures.push(`frame 2: picker offers ${labels.length} options, expected 6: ${labels.join(' | ')}`)
}
const glossed = `SessionLaneChanged — ${GLOSS}`
if (!labels.includes(glossed)) {
  failures.push(`frame 2: no option reads ${JSON.stringify(glossed)}; got ${labels.join(' | ')}`)
}
await page.screenshot({ path: `${OUT}/2-hooks-event-picker-open.png` })

// ---- frame 3: the lane-selected form, which is where the guidance lives ----
// Neither earlier frame shows the state a lane-hook author actually works in: the
// event picked, its own placeholder, and the guidance that carries the working shape.
await page.getByRole('option', { name: glossed }).click()
const laneHint = page.getByTestId('lane-matcher-hint')
await laneHint.waitFor({ state: 'visible', timeout: 15000 })
const hintText = (await laneHint.textContent()) || ''
if (!hintText.includes('KIROCREW_HOOK_CONTEXT')) {
  failures.push(`frame 3: the hint names no working route: ${JSON.stringify(hintText)}`)
}
// Empty is the recommended state, so nothing here may be styled as a problem.
if ((await page.getByTestId('lane-matcher-never-fires').count()) > 0) {
  failures.push('frame 3: the empty matcher is flagged as never-firing')
}
const hintClass = await laneHint.evaluate(el => el.className)
if (/text-warn/.test(hintClass)) {
  failures.push(`frame 3: the instruction is warn-styled while empty: ${hintClass}`)
}
// Then the broken case, so both states are on the record in one frame set.
await page.getByPlaceholder(/leave empty/i).fill('Done')
const neverFires = page.getByTestId('lane-matcher-never-fires')
await neverFires.waitFor({ state: 'visible', timeout: 15000 })
await page.screenshot({ path: `${OUT}/3-hooks-lane-selected-matcher-guidance.png` })

await browser.close()

if (problems.length) failures.push(...problems)
if (failures.length) {
  console.error(failures.map(f => `  ${f}`).join('\n'))
  process.exit(1)
}
console.log(`ok — 3 frames in ${OUT}: the pill, the six-event picker, and the lane-selected form`)
