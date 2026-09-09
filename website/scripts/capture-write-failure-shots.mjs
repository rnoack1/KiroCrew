// Frames for the shared in-page notice a REJECTED gateway write reports to --
// the surface that replaced silent rollbacks and a native alert(). Run from website/:
//   node scripts/capture-write-failure-shots.mjs <outdir>
//
// The rejection is produced by Playwright routing the real PATCH to a 500, and the
// notice is rendered by the real component reading the real store: nothing about
// the failure is staged in the harness.
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const outDir = process.argv[2] || path.join(process.env.TMPDIR || '/tmp', 'write-failure-shots')
mkdirSync(outDir, { recursive: true })

const STUB_EMPTY_LIST = ['/api/chat/folders', '/api/chat/tags', '/api/chat/tag-columns']

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { port: 5217, strictPort: true, host: '127.0.0.1' },
})
await server.listen()
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  env: { ...process.env, LD_LIBRARY_PATH: '' },
})

const ctx = await browser.newContext({ viewport: { width: 380, height: 620 }, reducedMotion: 'reduce' })
const page = await ctx.newPage()
for (const p of STUB_EMPTY_LIST) {
  await page.route(`**${p}`, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
}
await page.route('**/api/chat/slots/*/pin', route =>
  route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' }))

await page.goto('http://127.0.0.1:5217/capture/offline-rename-gate.html?scene=write-failure')
await page.waitForSelector('text=Release notes draft', { timeout: 45000 })

const row = page.locator('.session-row').filter({ hasText: 'Release notes draft' }).first()
await row.hover()
await row.locator('[data-testid="session-menu-trigger"], button[aria-haspopup="menu"]').first().click()
await page.getByRole('menuitem', { name: /^Pin/ }).click()
await page.waitForSelector('[data-testid="session-action-error"] >> text=/pin/i', { timeout: 15000 })

const text = (await page.locator('[data-testid="session-action-error"]').innerText()).replace(/\s+/g, ' ')
const ok = /pin/i.test(text) && !/Failed to fetch/.test(text)
await page.screenshot({ path: path.join(outDir, 'write-failure-notice.png') })
console.log('shot write-failure-notice', JSON.stringify({ ok, text: text.slice(0, 140) }), ok ? 'OK' : 'MISMATCH')

await ctx.close()
await browser.close()
await server.close()
if (!ok) {
  console.error('the notice did not show the claimed rejected-write state')
  process.exit(1)
}
