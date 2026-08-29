/**
 * Capture the two session-close FAILURE notices, in page.
 *
 * Why this exists: the close failure used to reach the user through a native
 * `alert()`, which no screenshot can show (the browser chrome paints it, not the
 * app) and which the repo's `errors-use-error-notice` rule bans. It is now an
 * in-page `ErrorNotice` rendered by the App shell, so the surface is
 * photographable for the first time — and the UX review asked for exactly these
 * two dialogs, which appeared in no committed frame.
 *
 * Both frames come from a REAL failing DELETE, not from poking state: the stub
 * answers the close with the two server shapes that discriminate the branches.
 *
 *   - refused — a 500 carrying `definitive: true`. The gateway considered the
 *     close, refused it and rolled every partial step back, so the session is
 *     provably still there and closing it again is a well-defined retry.
 *   - unknown — a 503, which never reached the close path at all. The DELETE may
 *     yet have completed, and slot keys are reusable, so the copy must not send
 *     the user to close whatever now holds the name without checking it first.
 *
 * The run asserts IN BAND that each notice actually rendered and that the two
 * texts DIFFER, printing both. A harness that photographed an empty shell would
 * report `rendered=false`, and one whose branches collapsed to a single message
 * would report `distinct=false` — either way the frames prove nothing and the
 * exit code says so.
 *
 * Usage: node scripts/capture-session-close-failure-notice.mjs [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/session-close-failure-notice'
mkdirSync(OUT, { recursive: true })

const now = Math.floor(Date.now() / 1000)

// Not the active slot: closing the active one navigates, which would confound the
// notice with a page change.
const DOOMED = 'chat-nightly-triage'
const DOOMED_TITLE = 'Nightly triage sweep'

const slot = (key, title, modified, extra = {}) => ({
  key, title, running: false, messages: 6, agent: 'kirocrew',
  project_dir: '/home/z/KiroCrew', modified, last_ts: '2026-08-29T18:00:00Z',
  folder_id: '', last_message: 'Read the runbook and moved on.', ...extra,
})

const ALL = [
  slot('chat-current', 'Release checklist review', now, { messages: 12 }),
  slot(DOOMED, DOOMED_TITLE, now - 300),
  slot('chat-perf', 'Sidebar render profile', now - 900),
]

const REFUSED_BODY = {
  error: 'failed to retire nudge loop', code: 'nudge_retire_failed', definitive: true,
}

async function main() {
  const { srv, base } = await serveDist()
  // mise's node injects LD_LIBRARY_PATH at its own bundled libstdc++, older than the
  // system Mesa needs; children inherit it, so scrub it here.
  const { LD_LIBRARY_PATH: _mise, ...browserEnv } = process.env
  const browser = await chromium.launch({ env: browserEnv })
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })
  const page = await context.newPage()

  // Which failure the next DELETE answers with. Flipped between the two frames.
  let mode = 'refused'
  let deletes = 0

  await stubDashboardApi(page, {
    folders: [], slots: ALL,
    extra: async (path, route) => {
      if (path === '/api/chat/slots' && route.request().method() === 'GET') {
        // The list keeps naming the slot: BOTH failures leave it present, so the
        // refetch bringing the row back is the honest end state here.
        await json(route, ALL)
        return true
      }
      if (path === `/api/chat/slots/${DOOMED}` && route.request().method() === 'DELETE') {
        deletes++
        if (mode === 'refused') await json(route, REFUSED_BODY, 500)
        else await json(route, { error: 'upstream unavailable' }, 503)
        return true
      }
      if (path === `/api/chat/slots/${DOOMED}`) { await json(route, { messages: [], has_more: false, total: 0 }); return true }
      if (path === '/api/chat/slots/chat-current') {
        await json(route, { messages: [{ role: 'user', content: 'scratch', ts: '2026-08-29T18:00:00Z', meta: { mid: 'm-1' } }], has_more: false, total: 1 })
        return true
      }
      return false
    },
  })

  logPageProblems(page)

  const notice = page.locator('[data-testid="session-close-failed"]')

  /** Close the row once and photograph whatever notice it produces. */
  const shoot = async (label, file) => {
    await page.goto(`${base}/chat`, { waitUntil: 'domcontentloaded' })
    const row = page.locator('[role="button"]').filter({ hasText: DOOMED_TITLE }).first()
    await row.waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(900)
    await row.hover()
    const closeBtn = row.getByRole('button', { name: 'Close session' }).first()
    await closeBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await closeBtn.click()
    // The notice is the assertion: waiting on it means a frame that shows nothing
    // fails here rather than being saved as evidence of something.
    let rendered = true
    await notice.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => { rendered = false })
    const text = rendered ? ((await notice.textContent().catch(() => '')) ?? '').trim() : ''
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${OUT}/${file}` })
    console.log(`  ${label}: rendered=${rendered} text="${text}"`)
    return { rendered, text }
  }

  mode = 'refused'
  const refused = await shoot('1 refused', '1-close-refused-notice.png')

  mode = 'unknown'
  const unknown = await shoot('2 unknown', '2-close-unknown-notice.png')

  const distinct = refused.text !== '' && refused.text !== unknown.text
  console.log(
    `deletes=${deletes} refusedRendered=${refused.rendered} unknownRendered=${unknown.rendered} distinct=${distinct}`,
  )

  await browser.close()
  srv.close()
  if (!refused.rendered || !unknown.rendered || !distinct) process.exit(1)
}

main()
