/**
 * The lane matcher's shape rule must be PERSISTENT, not placeholder-only.
 *
 * A placeholder vanishes at the first keystroke, and save accepts a wildcard-free
 * matcher without comment -- so the one warning that a bare lane name matches nothing
 * disappeared exactly when the user started typing a wrong value. This pins that the
 * helper renders for SessionLaneChanged and only for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

let hooksPayload: { hooks: unknown[] } = { hooks: [] }

vi.mock('../api/client', () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      if (prop === 'hooks') return vi.fn(async () => hooksPayload)
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

beforeEach(() => {
  vi.clearAllMocks()
  hooksPayload = { hooks: [] }
})

describe('hooks page — lane matcher helper', () => {
  it('is absent for the default event', async () => {
    renderPage()
    const trigger = await openForm()
    expect(trigger).toHaveTextContent('UserPromptSubmit')
    expect(screen.queryByTestId('lane-matcher-help')).toBeNull()
  })

  it('appears once the event is SessionLaneChanged, and survives typing', async () => {
    renderPage()
    const trigger = await openForm()
    await pickEvent(trigger, 'SessionLaneChanged')

    const help = await screen.findByTestId('lane-matcher-help')
    expect(help.textContent || '').toMatch(/matches nothing/i)

    // The whole point: a placeholder would be gone by now.
    const boxes = screen.getAllByRole('textbox')
    fireEvent.change(boxes[boxes.length - 1], { target: { value: 'done' } })
    expect(screen.getByTestId('lane-matcher-help')).toBeTruthy()
  })

  it('goes away again when the event moves off the lane event', async () => {
    renderPage()
    const trigger = await openForm()
    await pickEvent(trigger, 'SessionLaneChanged')
    expect(screen.getByTestId('lane-matcher-help')).toBeTruthy()
    await pickEvent(trigger, 'Stop')
    expect(screen.queryByTestId('lane-matcher-help')).toBeNull()
  })
})
