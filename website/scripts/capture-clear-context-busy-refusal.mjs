/**
 * Screenshots for the clear-context busy refusal on a channel.
 *
 * Drives the isolated capture entry (website/capture/clear-context-busy-refusal.html),
 * which mounts the REAL `Btn` and the REAL `ErrorNotice` the page renders, with the copy
 * resolved through the REAL `clearContextBusyMessage` exported from ChannelPage.
 *
 * The shipped refusal surface is the IN-PAGE banner, so each frame asserts the banner's
 * own text before writing: it must name every refusing role, the cause, and the retry.
 * A frame is not written unless those assertions hold, so an empty or mis-copied banner
 * fails the run rather than being committed as evidence. No dialog is expected on any
 * path -- one is asserted absent, since an earlier revision raised `alert()` here.
 *
 *   01-clear-all-two-roles-busy   partial clear-all, two of three roles mid-turn
 *   02-per-agent-role-busy        the per-agent control, its addressed role refusing
 *   03-clean-no-banner            contrast: nothing refused, no banner owed
 *
 * Usage:
 *   npx vite --host 127.0.0.1 --port 6841 --strictPort   # in another shell
 *   node scripts/capture-clear-context-busy-refusal.mjs http://127.0.0.1:6841 ../temp-screenshots/clear-context-busy-refusal
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:6841'
const OUT = process.argv[3] || '../temp-screenshots/clear-context-busy-refusal'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
let failed = false

function check(name, ok, detail) {
  console.log(`${name}: ${ok ? 'OK' : 'MISMATCH'} ${detail}`)
  if (!ok) failed = true
  return ok
}

/** Scenes, with what the banner must carry for the frame to be honest. The copy reuses
 * the page's own busy word ("working") rather than introducing separate vocabulary, and
 * never makes the role LIST the subject of a verb, so two roles read as well as one. */
const SCENES = [
  {
    file: '01-clear-all-two-roles-busy',
    scope: 'all',
    banner: true,
    mustCarry: ['Researcher', 'Analyst', 'kept for', 'still working', 'Clear again when they finish', 'Cleared for Scribe', 'Context partially cleared'],
    // The hand-off would unmount the page and destroy an unsent composer draft. The bold
    // FAILURE lead is wrong here too: this scene did clear a role.
    mustNotCarry: ['Ask the agent', 'Failed to clear context'],
  },
  {
    file: '02-per-agent-role-busy',
    scope: 'agent',
    banner: true,
    // `scope=agent` touches only the addressed member, so a refusal there is `busy && !cleared`
    // -- a 409 with the failure lead, never the partial/amber shape a clear-all can produce.
    mustCarry: ['Researcher', 'kept for', 'still working', 'Failed to clear context'],
    mustNotCarry: ['Ask the agent', 'Context partially cleared', 'Cleared for Scribe'],
  },
  { file: '03-clean-no-banner', scope: 'clean', banner: false, mustCarry: [] },
  {
    // A TOTAL refusal is a 409 and arrives as a throw. It must render the SAME localized
    // refusal as the partial case -- not the backend's English prose, which would read as
    // doubled phrasing and land untranslated on a localized page.
    file: '04-total-refusal-409',
    scope: 'total',
    banner: true,
    mustCarry: ['Researcher', 'Analyst', 'kept for', 'still working', 'Clear again when they finish'],
    mustNotCarry: ['Nothing was cleared', 'turn in flight', 'Ask the agent'],
  },
  {
    // The generic failure path, which this change moved off `alert()`.
    file: '05-generic-failure-inline',
    scope: 'failure',
    banner: true,
    mustCarry: ['channel store unavailable'],
  },
]

for (const theme of ['dark', 'light']) {
  for (const scene of SCENES) {
    const page = await browser.newPage({ viewport: { width: 760, height: 250 }, deviceScaleFactor: 2 })

    // The shipped path raises no dialog; assert that rather than assume it.
    const dialogs = []
    page.on('dialog', async d => {
      dialogs.push(d.message())
      await d.dismiss()
    })

    await page.goto(`${BASE}/capture/clear-context-busy-refusal.html?theme=${theme}&scope=${scene.scope}`)
    await page.waitForSelector('[data-capture-root]')
    await page.click('[data-capture-clear]')
    // `attached`, not visible: the wrapper is empty on the clean scene, where the whole
    // point is that no banner renders.
    await page.waitForSelector('[data-capture-notice]', { state: 'attached' })

    const notice = page.getByTestId('clear-context-error')
    if (scene.banner) await notice.waitFor({ timeout: 5000 }).catch(() => {})
    const shown = (await notice.count()) === 1
    const text = shown ? ((await notice.textContent()) || '') : ''
    const carried = scene.mustCarry.every(s => text.includes(s))
    // The 409 frame's whole point is that the backend's English did NOT leak through.
    const leaked = (scene.mustNotCarry || []).filter(s => text.includes(s))
    const bannerOk = shown === scene.banner

    const name = `${scene.file}-${theme}`
    if (
      check(
        name,
        bannerOk && carried && leaked.length === 0 && dialogs.length === 0,
        `banner=${shown}/${scene.banner} carried=${carried} leaked=${JSON.stringify(leaked)} dialogs=${dialogs.length} text=${JSON.stringify(text.slice(0, 140))}`,
      )
    ) {
      await page.screenshot({ path: `${OUT}/${name}.png` })
    }
    await page.close()
  }
}

await browser.close()
process.exit(failed ? 1 : 0)
