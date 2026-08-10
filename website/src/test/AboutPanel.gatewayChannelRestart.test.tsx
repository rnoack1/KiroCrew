//
// Contract under test — the gateway (non-Electron) channel switcher and the
// standalone Restart control in Settings > About.
//
// Why these exist: a wheel install cannot replace its own code, so the panel
// hands the user an installer command. Two things were missing afterwards.
//
// - There was no way to change WHICH channel is followed. The switcher is
//   THREE-way here (cli.sh installs nightly as a first-class lane), unlike the
//   desktop's two-way stable/insider control, whose nightly is a separate
//   side-by-side app a feed switch cannot reach.
// - There was no way to RELOAD after running the command. The installer
//   replaced the code on disk while this process kept executing the old
//   version, and killing it by hand was the only route.
//
// The switcher must only appear where the backend can honour it: a git checkout
// follows a remote and a desktop bundle / container is updated by something
// else, so both report no channel and get no control.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { store } from '../store'
import { sseStatus } from '../store/dashboardSlice'
import { MemoryRouter } from 'react-router-dom'
import { AboutPanel } from '../pages/settings/AboutPanel'

/** A minimal-but-valid status payload; `sseStatus` dereferences it, so never null. */
const BLANK_STATUS = {
  uptime: '1m', sessions: 0, messages: 0, cron_jobs: 0, subagents: 0, lessons: 0,
} as const

/**
 * Route every request the panel makes. `posts` records POST urls + bodies so a
 * test can assert what the control actually sent, not merely that it rendered.
 */
function stubFetch(opts: {
  check?: Record<string, unknown>
  channelResponse?: Record<string, unknown>
  channelStatus?: number
} = {}) {
  const posts: { url: string; body: unknown }[] = []
  const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  })
  const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      if (url.includes('/api/update/channel')) {
        return json(opts.channelResponse ?? { ok: true, channel: 'nightly' }, opts.channelStatus ?? 200)
      }
      return json({ ok: true })
    }
    if (url.includes('/api/update/check')) return json(opts.check ?? {})
    if (url.includes('/api/changelog')) return json({ content: '' })
    return json({})
  })
  vi.stubGlobal('fetch', spy)
  return posts
}

function mountWeb() {
  // No window.updateAPI => isDesktop false => the gateway branch renders.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <Provider store={store}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AboutPanel />
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  )
}

/** Seed the background check's answer, which is what the switcher reads on mount. */
function seedStatus(extra: Record<string, unknown>) {
  store.dispatch(sseStatus({ ...BLANK_STATUS, ...extra } as never))
}

describe('AboutPanel gateway channel switcher', () => {
  beforeEach(() => {
    delete (window as unknown as { updateAPI?: unknown }).updateAPI
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    store.dispatch(sseStatus({ ...BLANK_STATUS } as never))
  })

  it('offers all three lanes, marking the followed one selected', async () => {
    stubFetch()
    seedStatus({ update_channel: 'insider' })
    mountWeb()

    const switcher = await screen.findByTestId('gateway-channel-switcher')
    // Nightly being offered at all is the whole difference from the desktop
    // switcher, which can only move between stable and insider.
    for (const lane of ['Stable', 'Insider', 'Nightly']) {
      expect(within(switcher).getByTitle(lane)).toBeTruthy()
    }
  })

  it('sends the picked channel to the backend', async () => {
    const posts = stubFetch({ channelResponse: { ok: true, channel: 'nightly', checked: true, available: false } })
    seedStatus({ update_channel: 'stable' })
    mountWeb()

    const switcher = await screen.findByTestId('gateway-channel-switcher')
    fireEvent.click(within(switcher).getByTitle('Nightly'))

    await waitFor(() => {
      const call = posts.find(p => p.url.includes('/api/update/channel'))
      expect(call).toBeTruthy()
      expect(call!.body).toEqual({ channel: 'nightly' })
    })
  })

  it('does not re-send the channel already followed', async () => {
    const posts = stubFetch()
    seedStatus({ update_channel: 'stable' })
    mountWeb()

    const switcher = await screen.findByTestId('gateway-channel-switcher')
    fireEvent.click(within(switcher).getByTitle('Stable'))

    // A no-op POST would drop the cached verdict for nothing and re-hit the feed.
    await new Promise(r => setTimeout(r, 20))
    expect(posts.some(p => p.url.includes('/api/update/channel'))).toBe(false)
  })

  it('surfaces a rejected switch instead of showing the new lane as selected', async () => {
    stubFetch({ channelResponse: { error: 'not applicable', code: 'channel_not_applicable_git' }, channelStatus: 409 })
    seedStatus({ update_channel: 'stable' })
    mountWeb()

    const switcher = await screen.findByTestId('gateway-channel-switcher')
    fireEvent.click(within(switcher).getByTitle('Insider'))

    await waitFor(() => expect(screen.getByTestId('gateway-channel-error')).toBeTruthy())
  })

  it('is absent when the layout has no channel to switch', async () => {
    // A git checkout / desktop bundle / container reports update_channel "" —
    // the backend answers 409, so offering the control would be a lie.
    stubFetch()
    seedStatus({ update_channel: '' })
    mountWeb()

    await screen.findByRole('button', { name: /check for updates/i })
    expect(screen.queryByTestId('gateway-channel-switcher')).toBeNull()
  })

  it('explains all three lanes behind the disclosure', async () => {
    stubFetch()
    seedStatus({ update_channel: 'stable' })
    mountWeb()

    const toggle = await screen.findByTestId('gateway-channel-help-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('gateway-channel-help')).toBeNull()

    fireEvent.click(toggle)
    const help = screen.getByTestId('gateway-channel-help')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // Every lane the switcher offers must be explained, or the control asks for
    // a choice it never described.
    for (const label of [/stable/i, /insider/i, /nightly/i]) {
      expect(help.textContent).toMatch(label)
    }
  })
})

describe('AboutPanel gateway restart', () => {
  beforeEach(() => {
    delete (window as unknown as { updateAPI?: unknown }).updateAPI
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    store.dispatch(sseStatus({ ...BLANK_STATUS } as never))
  })

  it('offers Restart beside the installer command a wheel install must run', async () => {
    const posts = stubFetch()
    // available + !self_updatable is the manual-update path: the command is the
    // only way forward, and restarting is the step that used to be missing.
    seedStatus({
      update_available: true,
      update_checked: true,
      update_self_updatable: false,
      update_command: 'curl -fsSL https://example.test/cli.sh | sh -s -- --channel stable',
      update_channel: 'stable',
    })
    mountWeb()

    await screen.findByTestId('manual-update-command')
    const restart = screen.getByTestId('gateway-restart')
    fireEvent.click(restart)

    await waitFor(() => expect(posts.some(p => p.url.includes('/api/restart'))).toBe(true))
  })

  it('treats the connection drop after a restart as success, not failure', async () => {
    // os.execv replaces the process image, so the POST's connection is reset by
    // the very thing it asked for. Reporting that as an error would tell the
    // user the restart failed at the exact moment it worked.
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/api/restart')) throw new TypeError('Failed to fetch')
      return {
        ok: true, status: 200,
        json: async () => (url.includes('/api/update/check') ? {} : {}),
        text: async () => '{}',
        headers: new Headers({ 'content-type': 'application/json' }),
      }
    }))
    seedStatus({
      update_available: true,
      update_checked: true,
      update_self_updatable: false,
      update_command: 'curl -fsSL https://example.test/cli.sh | sh',
      update_channel: 'stable',
    })
    mountWeb()

    await screen.findByTestId('manual-update-command')
    fireEvent.click(screen.getByTestId('gateway-restart'))

    // The button reports the restart in progress rather than an error.
    await waitFor(() => {
      const btn = screen.getByTestId('gateway-restart')
      expect(btn.getAttribute('disabled')).not.toBeNull()
    })
  })
})
