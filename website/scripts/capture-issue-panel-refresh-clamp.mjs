/**
 * Screenshot runner for capture/issue-panel-refresh-clamp.html.
 *
 * From website/:
 *   npx vite --host 127.0.0.1 --port 6832 --strictPort
 *   node scripts/capture-issue-panel-refresh-clamp.mjs http://127.0.0.1:6832 <outdir> [before|after]
 *
 * `after` (default) asserts the notice message carries `line-clamp-1`, exposes
 * its full text as a `title`, and occupies ONE line, so the compact row cannot
 * grow and push Retry and the issue body down. `before`, run against the same
 * harness with the clamp absent, asserts the opposite — the message must
 * actually wrap past one line there. Neither mode can photograph the wrong tree:
 * the assertion that guards each frame fails on the other's markup.
 *
 * `de` is the default catalog because it ships the longest translation of the
 * string under test, which is the case the row has to survive.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:6832'
const OUT = process.argv[3] || '../temp-screenshots/instance-bar-error-overflow'
const MODE = process.argv[4] === 'before' ? 'before' : 'after'
mkdirSync(OUT, { recursive: true })

const LOCALES = MODE === 'after' ? ['de', 'en'] : ['de']
const browser = await chromium.launch()
let failed = 0

for (const locale of LOCALES) {
  const ctx = await browser.newContext({
    viewport: { width: 460, height: 520 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  try {
    await page.goto(`${BASE}/capture/issue-panel-refresh-clamp.html?locale=${locale}`, { waitUntil: 'networkidle' })
    await page.addStyleTag({
      content: '*, *::before, *::after { animation-duration: 0s !important;'
        + ' animation-delay: 0s !important; transition-duration: 0s !important;'
        + ' transition-delay: 0s !important; }',
    })
    await page.waitForSelector('[data-capture-panel]')
    // The row under test needs a LOADED issue whose refresh then fails, so wait
    // for the payload before asking for the refresh that fails.
    await page.getByText('Crash on empty label list').waitFor({ timeout: 10000 })
    // Icon-only header control, addressed by its icon because its accessible
    // name is localised and this harness deliberately switches catalogs. The
    // row's own Retry carries the same icon but does not exist yet.
    await page.locator('button:has(.lucide-refresh-cw)').first().click()

    const notice = page.getByTestId('issue-panel-refresh-error')
    await notice.waitFor({ timeout: 10000 })

    const geom = await notice.evaluate((el) => {
      // By clamp class, not by tag: the clipped message renders as a button so the
      // disclosure has real semantics, and as a span when the text already fits.
      const msg = el.querySelector('[class*="line-clamp"]')
      const row = el.parentElement
      // The row's own action, not the notice's: its label is localised too, and a
      // label that wraps grows the row just as a wrapping message would.
      const buttons = row ? [...row.querySelectorAll('button')] : []
      const retry = buttons.length ? buttons[buttons.length - 1] : null
      const cs = msg ? getComputedStyle(msg) : null
      const lineHeight = cs ? (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5) : 0
      return {
        text: msg ? msg.textContent : '',
        className: msg ? msg.className : '',
        title: msg ? (msg.getAttribute('title') || '') : '',
        msgHeight: msg ? msg.getBoundingClientRect().height : 0,
        lineHeight,
        rowHeight: row ? row.getBoundingClientRect().height : 0,
        retryHeight: retry ? retry.getBoundingClientRect().height : 0,
        retryText: retry ? (retry.textContent || '').trim() : '',
      }
    })
    if (!geom.text) throw new Error('could not find the notice message span')
    if (!geom.retryText) throw new Error('could not find the row\'s retry control')
    const lines = geom.msgHeight / geom.lineHeight
    const retryLines = geom.retryHeight / geom.lineHeight
    const clamped = /line-clamp-1/.test(geom.className)

    if (MODE === 'after') {
      if (!clamped) throw new Error('AFTER frame has no line-clamp-1 on the message')
      if (geom.title !== geom.text) throw new Error('clamped message does not expose its full text as a title')
      if (lines > 1.5) throw new Error(`clamped message still occupies ${lines.toFixed(2)} lines`)
      // The point of the clamp is that this row cannot grow, so nothing in it may
      // take a second line — a wrapped Retry label pushes the issue body down
      // exactly as the message did.
      if (retryLines > 1.5) {
        throw new Error(`retry control "${geom.retryText}" occupies ${retryLines.toFixed(2)} lines,`
          + ` growing the row to ${geom.rowHeight.toFixed(0)}px`)
      }
    } else {
      if (clamped) throw new Error('BEFORE frame is already clamped — wrong tree')
      if (lines <= 1.5) {
        throw new Error(`BEFORE frame does not reproduce the wrap (${lines.toFixed(2)} lines);`
          + ' a narrower ?panel= is needed for this catalog')
      }
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)

    await page.locator('[data-capture-root]').screenshot({ path: `${OUT}/issue-panel-narrow-${MODE}-${locale}.png` })

    if (MODE === 'after') {
      // `title` is pointer-only, so focus must surface the tail some other way.
      // Measured in a real browser: the markup alone would prove nothing.
      const msgBox = await notice.evaluate((el) => {
        const msg = el.querySelector('[class*="line-clamp"]')
        if (!msg) return null
        msg.focus()
        return { focused: document.activeElement === msg, rowHeight: el.parentElement.getBoundingClientRect().height }
      })
      if (!msgBox) throw new Error('lost the clamped message before the focus check')
      if (!msgBox.focused) throw new Error('the clamped message did not take focus — it is not reachable by tab or tap')

      const tip = page.locator('[role="tooltip"]')
      await tip.first().waitFor({ state: 'visible', timeout: 5000 })
      const tipText = (await tip.first().textContent() || '').trim()
      if (tipText.length <= geom.text.trim().length - 1) {
        throw new Error(`the focus popover shows "${tipText}", shorter than the clamped message itself`)
      }
      // The whole point of moving the reveal out of the row: the row must not grow,
      // which is what an in-place unclamp did and what the `h-8` bar cannot take.
      if (Math.abs(msgBox.rowHeight - geom.rowHeight) > 1) {
        throw new Error(`focus grew the row from ${geom.rowHeight.toFixed(0)}px to`
          + ` ${msgBox.rowHeight.toFixed(0)}px; the reveal must not change layout`)
      }
      await page.locator('[data-capture-root]').screenshot({ path: `${OUT}/issue-panel-narrow-focus-${locale}.png` })
      console.log(`${MODE}-${locale}: message ${lines.toFixed(2)} line(s), retry ${retryLines.toFixed(2)} line(s),`
        + ` row ${geom.rowHeight.toFixed(0)}px, clamped=${clamped},`
        + ` focus popover ${tipText.length} chars, row unchanged — OK`)
    } else {
      console.log(`${MODE}-${locale}: message ${lines.toFixed(2)} line(s), retry ${retryLines.toFixed(2)} line(s),`
        + ` row ${geom.rowHeight.toFixed(0)}px, clamped=${clamped} — OK`)
    }
  } catch (e) {
    console.error(`${MODE}-${locale}: FAILED — ${e}`)
    failed++
  } finally {
    await ctx.close()
  }
}

await browser.close()
process.exit(failed ? 1 : 0)
