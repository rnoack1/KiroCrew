import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import FollowUpBar from '../components/FollowUpBar'

/**
 * A chip's tooltip must describe what its click actually does.
 *
 * With quick send on and one chip already picked, a click ADDS TO THE SELECTION -- quick send
 * declines once anything is picked. The tooltip claimed a double-click would select and send,
 * because the send-eligibility flag was passed where the quick-send setting belonged, leaving
 * the add-to-selection wording unreachable.
 *
 * Read through `role="tooltip"` after a focus, which is how the hint reaches the DOM: the
 * native `title` these assertions used to read is gone, and reading an absent attribute made
 * every one of them pass without testing anything.
 */
describe('FollowUpBar chip tooltip agrees with the click', () => {
  const opts = ['Merge it now', 'Skip it']

  function hint(picked: string[], name: string): string {
    render(
      <FollowUpBar
        options={opts}
        recommended={null}
        picked={new Set(picked)}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        quickSend
      />,
    )
    fireEvent.focus(screen.getByRole('button', { name }))
    return screen.getByRole('tooltip').textContent ?? ''
  }

  it('offers instant send only while nothing is picked', () => {
    expect(hint([], 'Merge it now')).toMatch(/instantly/i)
  })

  it('says add-to-selection once something is picked, not double-click-to-send', () => {
    const text = hint(['Merge it now'], 'Skip it')
    // The defect: this read "double-click to select and send" while the click only adds.
    expect(text).not.toMatch(/double-click/i)
    expect(text).toMatch(/selection/i)
  })

  it('never advertises instant send once something is picked', () => {
    expect(hint(['Merge it now'], 'Skip it')).not.toMatch(/instantly/i)
  })

  it('does not promise a send on a command-shaped chip', () => {
    // The send apparatus is dropped for a chip whose click cannot dispatch, so a tooltip
    // promising one would advertise a gesture that does nothing.
    render(
      <FollowUpBar
        options={['/clear', 'Merge it now']}
        recommended={null}
        picked={new Set<string>()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        quickSend
      />,
    )
    fireEvent.focus(screen.getByRole('button', { name: '/clear' }))
    const text = screen.getByRole('tooltip').textContent ?? ''
    expect(text).not.toMatch(/instantly|double-click/i)
    // Positive control: the ordinary sibling DOES advertise it, so the assertion discriminates.
    fireEvent.blur(screen.getByRole('button', { name: '/clear' }))
    fireEvent.focus(screen.getByRole('button', { name: 'Merge it now' }))
    expect(screen.getByRole('tooltip').textContent ?? '').toMatch(/instantly|double-click/i)
  })
})
