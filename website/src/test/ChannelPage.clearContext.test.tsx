import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChannelPage from '../pages/ChannelPage'
import { renderWithProviders } from './helpers'
import { api, ApiError } from '../api/client'
import { clearContextBusyMessage, clearContextBusyRefusal } from '../pages/ChannelPage'
import { initI18n } from '../i18n/all'

// PARTIAL, not an automock: the helper under test narrows on `e instanceof ApiError`, and an
// automocked class makes that fail for both the test and the component that imports it.
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  const stub = Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn()]))
  return { ...actual, api: stub as unknown as typeof actual.api }
})

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()
})

const mockChannel = {
  id: 'ch1',
  topic: 'Test Channel',
  members: {
    a1: { id: 'a1', role: 'Researcher', agent_name: 'kirocrew', state: 'listening', listen_mode: 'mention', approval_policy: 'writes', session_key: 'k1' },
  },
  messages: [],
}

describe('ChannelPage — Clear Context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api).channelsList = vi.fn().mockResolvedValue({ channels: [mockChannel] })
    vi.mocked(api).channelGet = vi.fn().mockResolvedValue(mockChannel)
    vi.mocked(api).channelPresets = vi.fn().mockResolvedValue({ presets: [] })
    vi.mocked(api).channelClearContext = vi.fn().mockResolvedValue({ ok: true, cleared: ['Researcher'] })
  })

  it('renders Clear Context button in channel header', async () => {
    renderWithProviders(<ChannelPage />)
    await waitFor(() => expect(screen.getByTitle('Clear all context')).toBeInTheDocument())
  })

  it('calls channelClearContext with scope=all on confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderWithProviders(<ChannelPage />)
    await waitFor(() => expect(screen.getByTitle('Clear all context')).toBeInTheDocument())
    await userEvent.click(screen.getByTitle('Clear all context'))
    await waitFor(() => expect(vi.mocked(api).channelClearContext).toHaveBeenCalledWith('ch1', 'all'))
  })

  it('does not call API when confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderWithProviders(<ChannelPage />)
    await waitFor(() => expect(screen.getByTitle('Clear all context')).toBeInTheDocument())
    await userEvent.click(screen.getByTitle('Clear all context'))
    expect(vi.mocked(api).channelClearContext).not.toHaveBeenCalled()
  })

  it('re-fetches channel data after successful clear', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    vi.mocked(api).channelGet.mockClear()  // ignore the initial-render fetch
    await userEvent.click(screen.getByTitle('Clear all context'))
    await waitFor(() => expect(vi.mocked(api).channelGet).toHaveBeenCalledWith('ch1'))
  })

  it('reports an API failure through the in-page ErrorNotice, not a native alert', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    vi.mocked(api).channelClearContext = vi.fn().mockRejectedValue(new Error('server error'))
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    await userEvent.click(screen.getByTitle('Clear all context'))
    // Its OWN notice, not the page-wide one: this can render above an unsent composer
    // draft, so it must not carry the agent hand-off that would unmount the page.
    const notice = await screen.findByTestId('clear-context-error')
    expect(notice.textContent).toContain('Failed to clear context')
    expect(notice.textContent).toContain('server error')
    expect(notice.textContent).not.toContain('Ask the agent')
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('does not claim failure when the clear succeeded and only the refresh threw', async () => {
    // The refresh is a redraw, not the operation. Reporting its failure as the clear's sends
    // the user back through the confirm to re-clear work that is already gone.
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(api).channelClearContext = vi.fn().mockResolvedValue({ ok: true, busy: [] })
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    vi.mocked(api).channelGet = vi.fn().mockRejectedValue(new Error('refresh exploded'))
    await userEvent.click(screen.getByTitle('Clear all context'))
    await waitFor(() => expect(api.channelClearContext).toHaveBeenCalled())
    expect(screen.queryByTestId('clear-context-error')).toBeNull()
  })

  it('drops a stale clear-context refusal naming channel A roles when switching to channel B', async () => {
    // Nothing else clears it: the only other path is the user dismissing it by hand, so
    // it would read as a live refusal for whichever channel the composer now sends to.
    const other = { ...mockChannel, id: 'ch2', topic: 'Second Channel' }
    vi.mocked(api).channelsList = vi.fn().mockResolvedValue({ channels: [mockChannel, other] })
    vi.mocked(api).channelGet = vi.fn().mockImplementation(async (id: string) =>
      id === 'ch2' ? other : mockChannel,
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(api).channelClearContext = vi.fn().mockRejectedValue(new Error('server error'))
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    await userEvent.click(screen.getByTitle('Clear all context'))
    const notice = await screen.findByTestId('clear-context-error')
    expect(notice.textContent).toContain('server error')

    await userEvent.click(screen.getByText('Second Channel'))

    await waitFor(() =>
      expect(screen.queryByTestId('clear-context-error')).toBeNull(),
      { timeout: 2000 },
    )
  })

  it('never shows channel A refusal that resolves only after the switch to channel B', async () => {
    // The switch-time effect cannot reach a request still in flight, so A's refusal lands
    // afterwards and reads as live for B, whose roles it does not even name.
    const other = { ...mockChannel, id: 'ch2', topic: 'Second Channel' }
    vi.mocked(api).channelsList = vi.fn().mockResolvedValue({ channels: [mockChannel, other] })
    vi.mocked(api).channelGet = vi.fn().mockImplementation(async (id: string) =>
      id === 'ch2' ? other : mockChannel,
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let releaseA: (v: unknown) => void = () => {}
    const pending = new Promise(res => { releaseA = res })
    vi.mocked(api).channelClearContext = vi.fn().mockImplementation(async () => {
      await pending
      return { ok: true, busy: ['Researcher'], cleared: [] }
    })
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    await userEvent.click(screen.getByTitle('Clear all context'))

    await userEvent.click(screen.getByText('Second Channel'))
    releaseA({})

    await waitFor(() => expect(api.channelClearContext).toHaveBeenCalled())
    expect(screen.queryByTestId('clear-context-error')).toBeNull()
  })

  it('leads a partial clear with a partial title, not the bold failure lead', async () => {
    // A bold "Failed to clear context" over a body that ends "Cleared for Analyst." reads
    // as a total failure, sending the user back to re-clear what already cleared.
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(api).channelClearContext = vi.fn().mockResolvedValue({
      ok: true, busy: ['Researcher'], cleared: ['Analyst'],
    })
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    await userEvent.click(screen.getByTitle('Clear all context'))
    const notice = await screen.findByTestId('clear-context-error')
    expect(notice.textContent).toContain('Cleared for Analyst.')
    expect(notice.textContent).toContain('Context partially cleared')
    expect(notice.textContent).not.toContain('Failed to clear context')
    // Colour is read before the words are: danger chrome on a partial SUCCESS reports a
    // failure that did not happen, and invites re-clearing the roles already done.
    expect(notice.className).toContain('border-warn')
    expect(notice.className).not.toContain('border-danger')
  })

  it('keeps the failure lead when a busy refusal cleared nothing at all', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(api).channelClearContext = vi.fn().mockResolvedValue({
      ok: true, busy: ['Researcher'], cleared: [],
    })
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    await userEvent.click(screen.getByTitle('Clear all context'))
    const notice = await screen.findByTestId('clear-context-error')
    expect(notice.textContent).toContain('Failed to clear context')
    expect(notice.textContent).not.toContain('Context partially cleared')
    // Nothing cleared, so this one IS a failure and keeps the danger chrome.
    expect(notice.className).toContain('border-danger')
  })

  it('drops the refusal banner once a retry finally clears cleanly', async () => {
    // The banner tells the user to retry when the busy roles finish; if the successful
    // retry leaves it mounted, the advice it gives is about an attempt already superseded.
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(api).channelClearContext = vi.fn()
      .mockResolvedValueOnce({ ok: true, busy: ['Researcher'], cleared: [] })
      .mockResolvedValueOnce({ ok: true, busy: [], cleared: ['Researcher'] })
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByTitle('Clear all context'))
    await userEvent.click(screen.getByTitle('Clear all context'))
    await screen.findByTestId('clear-context-error')

    await userEvent.click(screen.getByTitle('Clear all context'))

    await waitFor(() =>
      expect(screen.queryByTestId('clear-context-error')).toBeNull(),
      { timeout: 2000 },
    )
  })

  it('clears a single agent via the agents panel with scope=agent', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderWithProviders(<ChannelPage />)
    await waitFor(() => screen.getByRole('button', { name: '1 agent' }))
    await userEvent.click(screen.getByRole('button', { name: '1 agent' }))  // open agents sidebar
    await waitFor(() => screen.getByTitle('Clear context'))
    await userEvent.click(screen.getByTitle('Clear context'))
    await waitFor(() => expect(vi.mocked(api).channelClearContext).toHaveBeenCalledWith('ch1', 'agent', 'a1'))
  })
})

/**
 * The clear-context click's decision about what the user is owed.
 *
 * A PARTIAL refusal answers 200 with the refusing roles in `busy`, so the
 * caller's catch never sees it and only reading that field keeps the click
 * honest. Before this helper existed the field had no reader at all, so a
 * refused clear rendered as a successful one.
 */
describe('clearContextBusyMessage', () => {
  beforeAll(() => {
    initI18n('en')
  })

  it('names every refusing role, so the user knows what to retry', () => {
    const msg = clearContextBusyMessage({ busy: ['Researcher', 'Analyst'] })
    expect(msg).toContain('Researcher')
    expect(msg).toContain('Analyst')
  })

  it('is empty when nothing refused, so a clean clear raises no dialog', () => {
    expect(clearContextBusyMessage({ busy: [] })).toBe('')
  })

  it('is empty for a response that omits the field entirely', () => {
    expect(clearContextBusyMessage({})).toBe('')
    expect(clearContextBusyMessage(null)).toBe('')
    expect(clearContextBusyMessage(undefined)).toBe('')
  })

  it('names the roles that DID clear, so a partial refusal does not read as a total one', () => {
    const msg = clearContextBusyMessage({ busy: ['Researcher'], cleared: ['Scribe', 'Analyst'] })
    expect(msg).toContain('Researcher')
    expect(msg).toContain('Scribe, Analyst')
  })

  it('omits the cleared clause when nothing cleared, so a total refusal claims nothing', () => {
    const msg = clearContextBusyMessage({ busy: ['Researcher'], cleared: [] })
    expect(msg).toContain('Researcher')
    expect(msg).not.toContain('Cleared for')
  })

  it('ignores a non-array busy value rather than rendering "[object Object]"', () => {
    expect(clearContextBusyMessage({ busy: 'Researcher' })).toBe('')
    expect(clearContextBusyMessage({ busy: { role: 'Researcher' } })).toBe('')
  })
})

/**
 * The same refusal, arriving as a THROW.
 *
 * A total refusal answers 409 rather than 200, so it never reaches the helper
 * above. The page's generic `fail` would render the backend's prose through
 * `apiError` -- doubled phrasing, and untranslated on a localized page -- so the
 * 409 is recognised by its code and rendered from the catalog like the partial
 * case. Everything else answers '' and is left to `fail`.
 */
describe('clearContextBusyRefusal', () => {
  beforeAll(() => {
    initI18n('en')
  })

  it('renders the localized refusal for a 409, not the backend prose', () => {
    const body = JSON.stringify({
      error: 'context not cleared: Researcher had a turn in flight. Nothing was cleared — retry when idle.',
      code: 'turn_in_flight',
      busy: ['Researcher'],
    })
    const msg = clearContextBusyRefusal(new ApiError(409, 'conflict', body))
    expect(msg).toBe(clearContextBusyMessage({ busy: ['Researcher'] }))
    expect(msg).not.toContain('Nothing was cleared')
  })

  it('names every refusing role on a total refusal', () => {
    const body = JSON.stringify({ code: 'turn_in_flight', busy: ['Researcher', 'Analyst'] })
    const msg = clearContextBusyRefusal(new ApiError(409, 'conflict', body))
    expect(msg).toContain('Researcher')
    expect(msg).toContain('Analyst')
  })

  it('defers a 409 that is a different conflict to the generic path', () => {
    const body = JSON.stringify({ error: 'nope', code: 'some_other_conflict' })
    expect(clearContextBusyRefusal(new ApiError(409, 'boom', body))).toBe('')
  })

  it('defers a 409 whose body is not JSON at all', () => {
    expect(clearContextBusyRefusal(new ApiError(409, 'boom', '<html>502</html>'))).toBe('')
  })

  it('defers a 409 that carries the code but no roles', () => {
    const body = JSON.stringify({ code: 'turn_in_flight', busy: [] })
    expect(clearContextBusyRefusal(new ApiError(409, 'boom', body))).toBe('')
  })

  it('leaves a non-409 failure to the generic path', () => {
    expect(clearContextBusyRefusal(new ApiError(500, 'server error', ''))).toBe('')
    expect(clearContextBusyRefusal(new Error('network down'))).toBe('')
  })

  it('leaves a thrown non-Error to the generic path', () => {
    expect(clearContextBusyRefusal('a bare string')).toBe('')
  })
})
