/**
 * A lane must be choosable IN the page, not fetched from an API by hand.
 *
 * The tag ids are twelve hex characters and no other surface renders them, so before
 * this the only way to write a lane hook was to call the tags endpoint and copy one
 * across. These pin that the status lanes appear as choices, that clicking one writes
 * the whole glob, that non-status tags are excluded, and that a matcher with no
 * wildcard -- which saves cleanly and then never fires -- says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const TAGS = [
  { id: '9f2c1ab77e40', name: 'Done', status: true },
  { id: 'aa11bb22cc33', name: 'Review', status: true },
  { id: 'ff99ee88dd77', name: 'urgent', status: false },
  // Hand-edited tags.json: a glob metacharacter here would widen the matcher to EVERY
  // lane, so a close-out hook would fire for sessions it was never scoped to.
  { id: '*', name: 'Wildcard', status: true },
]

vi.mock('../api/client', () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      if (prop === 'hooks') return vi.fn(async () => ({ hooks: [] }))
      if (prop === 'chatTags') return vi.fn(async () => TAGS)
      return vi.fn().mockResolvedValue({})
    },
  }),
}))

vi.mock('../providers', () => ({
  useProvider: () => ({
    id: 'acp',
    capabilities: { hooks: false },
    labels: { hooksSection: 'Provider hooks' },
    fetchProviderHooks: () => Promise.resolve({}),
  }),
}))

import HooksPage from '../pages/HooksPage'

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HooksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: '+ New Hook' }))
  return screen.findByLabelText('Event')
}

async function pickEvent(trigger: HTMLElement, value: string) {
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: value }))
  await waitFor(() => expect(trigger).toHaveTextContent(value))
}

// The lane placeholder is the matcher field's own, so this cannot drift onto a sibling
// input the way an index into every textbox does.
function matcherBox() {
  return screen.getByPlaceholderText('*added:9f2c1ab77e40;*') as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

// The column chooser is a SELECT, not a row of buttons: a board has as many columns as it
// likes, and a button row is capped at two siblings.
async function openLanePicker() {
  const trigger = await screen.findByLabelText('Pick a column')
  fireEvent.click(trigger)
  return trigger
}

describe('hooks page — lane is selectable in the surface', () => {
  it('offers the status lanes and excludes non-status tags', async () => {
    renderPage()
    const trigger = await openForm()
    await pickEvent(trigger, 'SessionLaneChanged')

    await screen.findByTestId('lane-matcher-picker')
    await openLanePicker()

    expect(await screen.findByRole('option', { name: 'Done' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Review' })).toBeTruthy()
    // A non-status tag is not a board lane, so it can never appear in a delta.
    expect(screen.queryByRole('option', { name: 'urgent' })).toBeNull()
    // An id outside the backend's allowlist is not offered at all.
    expect(screen.queryByRole('option', { name: 'Wildcard' })).toBeNull()
  })

  it('refuses to build a glob from an id outside the allowlist', async () => {
    const { laneMatcherToken, isLaneIdSafe } = await import('../pages/hookEventWireValues')

    // Positive control: a real id still builds, or this test proves nothing.
    expect(isLaneIdSafe('9f2c1ab77e40')).toBe(true)
    expect(laneMatcherToken('9f2c1ab77e40')).toBe('*added:9f2c1ab77e40;*')

    for (const unsafe of ['*', '?', 'a*b', 'ID', 'a;b', 'a:b', '', 'a b', '[a]']) {
      expect(isLaneIdSafe(unsafe)).toBe(false)
      expect(laneMatcherToken(unsafe)).toBe('')
    }
  })

  it('writes the whole glob when a lane is chosen, so no id is ever typed', async () => {
    renderPage()
    const trigger = await openForm()
    await pickEvent(trigger, 'SessionLaneChanged')

    await screen.findByTestId('lane-matcher-picker')
    await openLanePicker()
    fireEvent.click(await screen.findByRole('option', { name: 'Done' }))

    await waitFor(() => expect(matcherBox().value).toBe('*added:9f2c1ab77e40;*'))
  })

  it('is absent for a non-lane event', async () => {
    renderPage()
    const trigger = await openForm()
    expect(trigger).toHaveTextContent('UserPromptSubmit')
    expect(screen.queryByTestId('lane-matcher-picker')).toBeNull()
  })
})

describe('hooks page — a matcher that can never fire says so', () => {
  it('warns when the lane matcher carries no wildcard', async () => {
    renderPage()
    const trigger = await openForm()
    await pickEvent(trigger, 'SessionLaneChanged')

    expect(screen.queryByTestId('lane-matcher-warning')).toBeNull()
    fireEvent.change(matcherBox(), { target: { value: 'Done' } })

    const warn = await screen.findByTestId('lane-matcher-warning')
    expect(warn.textContent || '').toMatch(/never fire/i)
  })

  it('clears once a wildcard is present', async () => {
    renderPage()
    const trigger = await openForm()
    await pickEvent(trigger, 'SessionLaneChanged')

    fireEvent.change(matcherBox(), { target: { value: 'Done' } })
    expect(await screen.findByTestId('lane-matcher-warning')).toBeTruthy()

    fireEvent.change(matcherBox(), { target: { value: '*added:9f2c1ab77e40;*' } })
    await waitFor(() => expect(screen.queryByTestId('lane-matcher-warning')).toBeNull())
  })
})
