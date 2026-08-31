import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import FollowUpBar from '../components/FollowUpBar'

/**
 * A chip that behaves differently from its siblings must say so WITHOUT hovering.
 *
 * In a quick-send row every chip sends on click, except one whose label would dispatch a
 * command -- that one fills the composer instead. Identical-looking siblings behaving
 * differently was reachable only through a tooltip or the under-bar note, i.e. after the
 * first surprising click. The dashed edge states it at rest.
 *
 * There used to be a SECOND such class: a chip whose `(recommended)` prefix the strip
 * declined to remove. The recommendation is carried out of band now, so no label is ever
 * rewritten and that class cannot occur -- which is why this file covers one kind of chip
 * and renders one note instead of three.
 */
describe('FollowUpBar marks a command-shaped chip at the chip itself', () => {
  function chips(options: string[]) {
    const { container } = render(
      <FollowUpBar
        options={options}
        recommended={options[0] ?? null}
        picked={new Set<string>()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        quickSend
      />,
    )
    return Array.from(container.querySelectorAll('button')).map(b => b.className)
  }

  const COMMAND = '/clear'
  const ORDINARY = 'Merge it now'
  // Reads like the old marker and is NOT command-shaped: it opens with `(`, so nothing
  // dispatches and a click sends exactly these bytes. Ordinary text now.
  const LOOKS_LIKE_A_MARKER = '(recommended) /clear'

  it('gives the command-shaped chip a dashed edge', () => {
    expect(chips([COMMAND, ORDINARY]).filter(c => c.includes('border-dashed')).length).toBe(1)
  })

  it('leaves an ordinary chip solid, so the marking actually discriminates', () => {
    const all = chips([COMMAND, ORDINARY])
    const dashed = all.filter(c => c.includes('border-dashed'))
    expect(dashed.length).toBe(1)
    expect(all.length - dashed.length).toBeGreaterThan(0)
  })

  it('marks nothing when no chip would dispatch', () => {
    expect(chips([ORDINARY, 'Skip it']).some(c => c.includes('border-dashed'))).toBe(false)
  })

  it('leaves a marker-looking label unmarked, since it dispatches nothing', () => {
    expect(chips([LOOKS_LIKE_A_MARKER, ORDINARY]).some(c => c.includes('border-dashed'))).toBe(
      false,
    )
  })

  it('refuses an embedded skill token too, which a leading test cannot see', () => {
    expect(chips(['Run the $deploy skill', ORDINARY]).filter(c => c.includes('border-dashed')).length).toBe(1)
  })

  it('marks it in the scroll layout too, which renders through a different map', () => {
    const { container } = render(
      <FollowUpBar
        options={[COMMAND, ORDINARY]}
        recommended={COMMAND}
        picked={new Set<string>()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        quickSend
        layout="scroll"
      />,
    )
    const all = Array.from(container.querySelectorAll('button')).map(b => b.className)
    expect(all.filter(c => c.includes('border-dashed')).length).toBe(1)
  })

  it('does not promise an instant send on a command-shaped chip', () => {
    const { container } = render(
      <FollowUpBar
        options={[COMMAND, ORDINARY]}
        recommended={null}
        picked={new Set<string>()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        quickSend
      />,
    )
    // The hint reaches the DOM through `role="tooltip"` on focus, not a `title` attribute.
    const buttons = Array.from(container.querySelectorAll('button'))
    const commandChip = buttons.find(b => (b.textContent || '').includes(COMMAND))!
    fireEvent.focus(commandChip)
    expect(screen.getByRole('tooltip').textContent ?? '').not.toMatch(/instantly|double-click/i)
    fireEvent.blur(commandChip)
    // Positive control: the ordinary sibling still offers it, so this discriminates.
    const ordinaryChip = buttons.find(b => (b.textContent || '').includes(ORDINARY))!
    fireEvent.focus(ordinaryChip)
    expect(screen.getByRole('tooltip').textContent ?? '').toMatch(/instantly|double-click/i)
  })

  function commandNote(options: string[]): string | null {
    const { container } = render(
      <FollowUpBar
        options={options}
        recommended={null}
        picked={new Set<string>()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        quickSend
      />,
    )
    const el = container.querySelector('[data-testid="command-shaped-note"]')
    return el ? el.textContent : null
  }

  it('explains a command-shaped chip VISIBLY, not only on hover', () => {
    // Touch and keyboard users never see a `title`, so the dashed edge was unexplained.
    const text = commandNote([COMMAND, ORDINARY])
    expect(text).toBeTruthy()
    expect(text).not.toContain('(recommended)')
  })

  it('shows no note when every option is ordinary', () => {
    expect(commandNote([ORDINARY, 'Skip it'])).toBeNull()
  })

  it('states the note as a guarantee, not a hedge', () => {
    // A click fills the composer, so warning that the option "could run" alarms the reader
    // about an outcome the code prevents.
    const text = commandNote([COMMAND, ORDINARY]) ?? ''
    expect(text).toContain('instead of being sent')
    expect(text).not.toContain('could run.')
    expect(text.split('.').filter(s => s.trim()).length).toBeLessThanOrEqual(2)
  })

  it('describes what happens rather than enumerating which characters trigger it', () => {
    // The enumeration was wrong twice: the predicate also fires on `!`, `$`, `action::` and an
    // embedded token anywhere. A list has to track a growing predicate.
    const text = commandNote([COMMAND, ORDINARY]) ?? ''
    expect(text).toBeTruthy()
    for (const sigil of ['“/”', '“@”', '"/"', '"@"', '`/`', '`@`']) {
      expect(text).not.toContain(sigil)
    }
    expect(text).toContain('composer')
  })

  it('shows exactly one note, never a stack of them', () => {
    const { container } = render(
      <FollowUpBar
        options={[COMMAND, 'Run the $deploy skill', ORDINARY]}
        recommended={null}
        picked={new Set<string>()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        quickSend
      />,
    )
    expect(container.querySelectorAll('p[data-testid$="-note"]')).toHaveLength(1)
  })
})
