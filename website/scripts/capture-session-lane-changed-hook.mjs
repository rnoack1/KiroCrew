/**
 * Screenshot harness + behavior check for the `SessionLaneChanged` hook event.
 *
 * Two subjects, both named by the Screenshot Evidence gate and the UX lane:
 *
 *   1. the hooks form's event picker OPEN, showing `SessionLaneChanged` as a sixth
 *      lifecycle option — the feature is unreachable from the dashboard without it;
 *   2. the hooks table rendering a `SessionLaneChanged` row, so the new event pill and
 *      its accent styling are visible next to a pre-existing event for contrast.
 *
 * It ASSERTS as well as photographs: each scene exits non-zero unless the option and
 * the pill actually rendered, so a silent regression cannot produce a passing capture.
 * Nothing in CI runs this file — the CI-enforced halves are
 * HooksPage.eventPicker.test.tsx (the picker offers exactly the six allowed events)
 * and test_session_lane_changed_hook.py's UI/backend parity test.
 *
 * Drives the ISOLATED capture entry (capture/session-lane-changed-hook.html) over the
 * vite dev server, the way the other capture/ pairs do, so it needs neither a built
 * dist nor the dist API stub.
 *
 * Usage: node scripts/capture-session-lane-changed-hook.mjs [outDir] [baseUrl]
 *   The dev server must already be serving: npx vite --host 127.0.0.1 --port 5199
 */
import { mkdirSync } from 'node:fs'

import { chromium } from 'playwright'

const OUT = process.argv[2] || '../temp-screenshots/session-lane-changed-hook'
const BASE = process.argv[3] || 'http://127.0.0.1:5199'
const PAGE = `${BASE}/capture/session-lane-changed-hook.html?theme=dark`

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
const problems = []
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
page.on('console', m => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`)
})

await page.goto(PAGE, { waitUntil: 'domcontentloaded' })

// ---- scene 1: the table, which is the landing state ------------------------
const pill = page.getByText('SessionLaneChanged', { exact: true }).first()
await pill.waitFor({ state: 'visible', timeout: 30000 })
await page.screenshot({ path: `${OUT}/1-hooks-table-session-lane-changed-pill.png` })

// ---- scene 2: the picker open, showing all six ----------------------------
await page.getByRole('button', { name: /new hook/i }).first().click()
const trigger = page.getByLabel('Event')
await trigger.waitFor({ state: 'visible', timeout: 15000 })
await trigger.click()
const options = page.getByRole('option')
await options.first().waitFor({ state: 'visible', timeout: 15000 })
const labels = await options.allTextContents()
await page.screenshot({ path: `${OUT}/2-hooks-event-picker-open.png` })

// ---- scene 3: the form with the lane event chosen -------------------------
// The helper, the lane picker and the no-wildcard warning appear ONLY here, so the
// first two scenes photograph none of the copy this feature's users actually read.
await page.getByRole('option', { name: 'SessionLaneChanged' }).click()
const help = page.getByTestId('lane-matcher-help')
await help.waitFor({ state: 'visible', timeout: 15000 })
const matcher = page.getByPlaceholder('*added:9f2c1ab77e40;*')
await matcher.fill('Done')
const warning = page.getByTestId('lane-matcher-warning')
await warning.waitFor({ state: 'visible', timeout: 15000 })
const helpText = (await help.textContent()) || ''
const warnText = (await warning.textContent()) || ''
await page.screenshot({ path: `${OUT}/3-hooks-lane-form-helper-and-warning.png` })

// ---- assertions: a capture that cannot silently stop proving anything -----
const failures = []
if (!labels.includes('SessionLaneChanged')) {
  failures.push(`picker is missing SessionLaneChanged; offered ${JSON.stringify(labels)}`)
}
if (labels.length !== 6) {
  failures.push(`picker offers ${labels.length} events, expected 6: ${JSON.stringify(labels)}`)
}
if (!/matches nothing/i.test(helpText)) {
  failures.push(`lane helper did not state the shape rule; read ${JSON.stringify(helpText)}`)
}
if (/api\/chat\/tags/.test(helpText)) {
  failures.push('lane helper still sends the author to the API for an id')
}
if (!/never fire/i.test(warnText)) {
  failures.push(`wildcard-free matcher did not warn; read ${JSON.stringify(warnText)}`)
}

await browser.close()

for (const p of problems) console.error(`PAGE PROBLEM ${p}`)
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  process.exit(1)
}
console.log(`ok — 3 screenshots in ${OUT}; picker offers ${labels.join(', ')}`)
