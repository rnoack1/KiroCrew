/**
 * Isolated capture entry for the `SessionLaneChanged` hook event.
 *
 * TWO SUBJECTS, both of which only a screenshot can falsify:
 *
 *   1. the event picker OPEN, showing `SessionLaneChanged` as a sixth lifecycle
 *      option — without it the feature is unreachable from the dashboard, which a
 *      review round found had actually happened;
 *   2. the hooks table rendering a `SessionLaneChanged` row, so the new event pill
 *      and its accent styling are visible beside a pre-existing event for contrast.
 *
 * ISOLATED because the dist harnesses' shared API stub also intercepts dev-server
 * source-module requests. This entry imports only this page, so it renders the REAL
 * one — components unmodified, only the hook records are fixtures. ?theme=dark
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'

import { initI18n } from '../src/i18n/all'
import HooksPage from '../src/pages/HooksPage'
import { store } from '../src/store'
import '../src/index.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') ?? 'dark'

// Fixtures only, no real user data: one lane hook plus one pre-existing event, so the
// new pill is compared against an established one rather than judged alone.
const HOOKS = [
  {
    id: 'a1b2c3d4',
    name: 'close-out on Done',
    event: 'SessionLaneChanged',
    matcher: '*added:9f2c1ab77e40;*',
    matcher_mode: 'glob',
    command: 'scripts/close-out.sh',
    timeout: 30,
    enabled: true,
    skills: [],
    run_count: 4,
    last_status: 'ok',
    last_error: '',
    last_run: Math.floor(Date.now() / 1000) - 240,
  },
  {
    id: 'e5f6a7b8',
    name: 'guard writes',
    event: 'PreToolUse',
    matcher: 'fs_write',
    matcher_mode: 'glob',
    command: 'scripts/guard.sh',
    timeout: 10,
    enabled: true,
    skills: [],
    run_count: 12,
    last_status: 'ok',
    last_error: '',
    last_run: Math.floor(Date.now() / 1000) - 3600,
  },
]

// The page's own fetches: a capture page has no gateway behind it, so an unanswered
// /api/hooks would leave the table in its loading state and photograph nothing.
const realFetch = window.fetch
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : ((input as Request).url ?? input))
  if (url.includes('/api/hooks')) {
    return new Response(JSON.stringify({ hooks: HOOKS }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.includes('/api/chat/tags')) {
    // Status tags are the board lanes the matcher picker offers.
    return new Response(
      JSON.stringify([
        { id: '9f2c1ab77e40', name: 'Done', status: true, order: 3 },
        { id: 'aa11bb22cc33', name: 'Review', status: true, order: 2 },
        { id: 'bb22cc33dd44', name: 'Implementation', status: true, order: 1 },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  if (url.includes('/api/')) {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return realFetch(input, init)
}) as typeof window.fetch

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

async function main() {
  await initI18n()
  createRoot(document.getElementById('root')!).render(
    <Provider store={store}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/hooks']}>
          <div
            style={{ background: 'var(--bg)', color: 'var(--text)', padding: 24 }}
            data-capture-root
          >
            <HooksPage />
          </div>
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  )
}

void main()
