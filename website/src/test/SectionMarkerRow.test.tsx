/**
 * Section markers render as a labelled rule on BOTH transcript surfaces.
 *
 * A parity test, not just a component test: the two paths disagree on the
 * unknown-role fallback — the single-chat role chain draws an assistant bubble,
 * the SDK registry draws nothing — so a row taught to only one is silently wrong
 * on the other, and both failures look fine from wherever you were looking.
 *
 * The role-parity contract test already fails when one path claims the role and
 * the other does not. What it cannot see is whether the row DRAWS a rule.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import SectionMarkerRow from '../pages/chat/SectionMarkerRow'
import {
  defaultMessageRenderers,
  resolveRenderer,
  type MessageRenderContext,
} from '../app-sdk/messageRenderers'
import type { ChatMessage } from '../types'

const here = dirname(fileURLToPath(import.meta.url))

const marker = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    role: 'section_marker',
    content: '— End of: second-item —',
    cls: '',
    meta: { label: 'second-item' },
    ...over,
  }) as ChatMessage

describe('SectionMarkerRow', () => {
  it('draws the label between two hairline rules', () => {
    const { container } = render(<SectionMarkerRow label="second-item" />)
    const row = container.querySelector('[data-testid="section-marker-row"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toBe('End of: second-item')
    // Two rules, one either side, so the label reads as a break rather than as a
    // heading with a trailing line.
    expect(container.querySelectorAll('span.h-px').length).toBe(2)
  })

  it('is a separator for assistive tech, named by its label', () => {
    const { container } = render(<SectionMarkerRow label="second-item" />)
    const row = container.querySelector('[role="separator"]')
    expect(row).not.toBeNull()
    expect(row!.getAttribute('aria-label')).toBe('End of: second-item')
  })

  it('names an unlabelled break in the reader language, not the backend one', () => {
    // `label=""` with that `content` is exactly what the applier sends for an
    // unlabelled marker, so this path must not draw its raw English text.
    const { container } = render(<SectionMarkerRow label="" fallback="— Section break —" />)
    const row = container.querySelector('[data-testid="section-marker-row"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toBe('Section break')
    expect(row!.textContent).not.toContain('—')
    expect(container.querySelectorAll('span.h-px').length).toBe(2)
  })

  it('distinguishes two unlabelled breaks by stamping each with its own time', () => {
    // Every unlabelled break draws the same caption, so the time is the only
    // thing separating one from the next.
    const { container } = render(<SectionMarkerRow label="" time="2:32 PM" />)
    const row = container.querySelector('[data-testid="section-marker-row"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Section break')
    expect(container.querySelector('[data-testid="section-marker-time"]')!.textContent).toBe('2:32 PM')
    expect(row!.getAttribute('aria-label')).toBe('Section break · 2:32 PM')
  })

  it('stamps a LABELLED break too, since the same label can be marked twice', () => {
    const { container } = render(<SectionMarkerRow label="second-item" time="2:32 PM" />)
    const row = container.querySelector('[data-testid="section-marker-row"]')
    expect(container.querySelector('[data-testid="section-marker-time"]')!.textContent).toBe('2:32 PM')
    expect(row!.textContent).toContain('End of: second-item')
    expect(row!.getAttribute('aria-label')).toBe('End of: second-item · 2:32 PM')
  })

  it('carries the full timestamp as a hover title while the visible stamp stays short', () => {
    const { container } = render(
      <SectionMarkerRow label="second-item" time="2:32 PM" timeTitle="Mar 20, 2026, 2:32:07 PM" />,
    )
    const stamp = container.querySelector('[data-testid="section-marker-time"]')!
    expect(stamp.getAttribute('title')).toBe('Mar 20, 2026, 2:32:07 PM')
    expect(stamp.textContent).toBe('2:32 PM')
  })

  it('emits no title attribute at all when no full timestamp is supplied', () => {
    const { container } = render(<SectionMarkerRow label="second-item" time="2:32 PM" />)
    const stamp = container.querySelector('[data-testid="section-marker-time"]')!
    expect(stamp.hasAttribute('title')).toBe(false)
  })

  it('documents why a structural row ships no dismiss control, and ships none', () => {
    const component = readFileSync(resolve(here, '../pages/chat/SectionMarkerRow.tsx'), 'utf8')
    expect(component).toMatch(/No dismiss affordance, deliberately/)
    const { container } = render(<SectionMarkerRow label="second-item" time="2:32 PM" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps the unlabelled caption on one framing in every shipped locale', () => {
    // English settled on "Section break"; a locale left on the older "end of section"
    // framing means the same rule reads as two different things to two readers.
    const superseded = [
      'End of section',
      'Ende des Abschnitts',
      'Fin de la sección',
      'Fin de la section',
      'Fine della sezione',
      'Fim da seção',
      'Конец раздела',
      'セクションの終わり',
      '섹션 끝',
      '本节结束',
      'अनुभाग का अंत',
      'বিভাগের শেষ',
    ]
    const dir = resolve(here, '../i18n/locales')
    const stale: string[] = []
    let checked = 0
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(resolve(dir, file), 'utf8'))
      const caption = data?.pages?.chat?.sectionMarkerRow?.end_of_section
      if (typeof caption !== 'string') continue
      checked += 1
      if (superseded.includes(caption)) stale.push(`${file}: ${caption}`)
    }
    // Positive control: the sweep has to actually reach the catalogs.
    expect(checked).toBeGreaterThan(10)
    expect(stale).toEqual([])
  })

  it('keeps two breaks carrying the SAME label distinguishable', () => {
    // An agent that retries a unit of work marks it twice with one label, so the
    // caption cannot separate them and only the time does.
    const first = render(<SectionMarkerRow label="Ticket 4132" time="2:32 PM" />)
    const second = render(<SectionMarkerRow label="Ticket 4132" time="4:10 PM" />)
    const nameOf = (r: ReturnType<typeof render>) =>
      r.container.querySelector('[role="separator"]')!.getAttribute('aria-label')
    expect(nameOf(first)).not.toBe(nameOf(second))
    const textOf = (r: ReturnType<typeof render>) =>
      r.container.querySelector('[data-testid="section-marker-row"]')!.textContent
    expect(textOf(first)).not.toBe(textOf(second))
    // Positive control: both really do carry the shared label, so this is not
    // passing because one of them failed to render its caption.
    expect(textOf(first)).toContain('Ticket 4132')
    expect(textOf(second)).toContain('Ticket 4132')
  })

  it('stamps an older-client row as well, so its break is separable too', () => {
    const { container } = render(<SectionMarkerRow fallback="— Section break —" time="2:32 PM" />)
    const row = container.querySelector('[data-testid="section-marker-row"]')
    expect(container.querySelector('[data-testid="section-marker-time"]')!.textContent).toBe('2:32 PM')
    expect(row!.textContent).toContain('— Section break —')
  })

  it('still draws a plain break for a row with neither meta nor content', () => {
    const { container } = render(<SectionMarkerRow />)
    const row = container.querySelector('[data-testid="section-marker-row"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toBe('')
    expect(container.querySelectorAll('span.h-px').length).toBe(2)
    // No empty accessible name — an aria-label of "" would announce a nameless
    // separator rather than an unnamed one.
    expect(row!.hasAttribute('aria-label')).toBe(false)
  })

  it('lets a long label wrap instead of overflowing the column', () => {
    // `shrink-0` sizes the span to max-content, so `break-words` never gets a
    // constrained box and a long label overflows the column instead of wrapping.
    const { container } = render(<SectionMarkerRow label={'wrap-me-'.repeat(14)} />)
    const span = container.querySelector('[data-testid="section-marker-row"] > span:not([aria-hidden])')
    expect(span).not.toBeNull()
    expect(span!.className).not.toContain('shrink-0')
    expect(span!.className).toContain('break-words')
    expect(span!.className).toContain('min-w-0')
  })

  it('renders the label as text, never as markup', () => {
    const { container } = render(<SectionMarkerRow label="<img src=x onerror=1>" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=1>')
  })
})

describe('the SDK path draws the rule', () => {
  it('resolves a section_marker row to its own registry entry', () => {
    // Not `undrawn` and not `undefined`: both draw nothing on screen, so only an
    // entry of its own is correct.
    expect(resolveRenderer(marker(), defaultMessageRenderers)?.id).toBe('section_marker')
  })

  it('renders the rule with the label from meta', () => {
    const entry = resolveRenderer(marker(), defaultMessageRenderers)!
    const ctx = { row: (node: React.ReactNode) => node } as unknown as MessageRenderContext
    const { container } = render(<>{entry.render(marker(), ctx)}</>)
    const row = container.querySelector('[data-testid="section-marker-row"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toBe('End of: second-item')
  })

  it('wires the full timestamp through from the row, not just the short stamp', () => {
    // The registry entry is the only place the two forms are paired, so the
    // component test cannot prove the caller supplies the longer one.
    const m = marker({ ts: '2026-03-20T14:32:07Z' })
    const entry = resolveRenderer(m, defaultMessageRenderers)!
    const ctx = { row: (node: React.ReactNode) => node } as unknown as MessageRenderContext
    const { container } = render(<>{entry.render(m, ctx)}</>)
    const stamp = container.querySelector('[data-testid="section-marker-time"]')!
    const title = stamp.getAttribute('title') ?? ''
    expect(title).not.toBe('')
    expect(title.length).toBeGreaterThan(stamp.textContent!.length)
  })

  it('falls back to content when meta carries no label', () => {
    // An older producer, or a row whose meta was dropped, still reads legibly
    // rather than as a blank rule. `content` is the compatibility surface.
    const m = marker({ meta: undefined })
    const entry = resolveRenderer(m, defaultMessageRenderers)!
    const ctx = { row: (node: React.ReactNode) => node } as unknown as MessageRenderContext
    const { container } = render(<>{entry.render(m, ctx)}</>)
    expect(container.textContent).toBe('— End of: second-item —')
  })
})

describe('ChatPage draws the rule too', () => {
  /**
   * ChatPage no longer carries a per-role if-chain: every transcript row resolves
   * through the SAME renderer registry the other surfaces consume, so the role needs
   * no branch on this page at all. What still has to hold is the CHAIN that gets the
   * row here -- the page merges the defaults, the defaults claim the role, and no host
   * entry shadows it -- so that is what these assert. A source match on a branch would
   * now pin the old architecture and pass while the row rendered as a stray bubble.
   */
  const src = readFileSync(resolve(here, '../pages/ChatPage.tsx'), 'utf8')
  const registry = readFileSync(resolve(here, '../app-sdk/messageRenderers.tsx'), 'utf8')

  it('dispatches through the registry that claims the role', () => {
    // The page resolves rows against a merged registry rather than its own chain.
    expect(/mergeRenderers\(/.test(src)).toBe(true)
    expect(/resolveRenderer\(/.test(src)).toBe(true)
    // A HOST entry re-using this id would shadow the default and silently drop the
    // row -- the one way this page can still lose the marker.
    expect(src).not.toMatch(/id:\s*'section_marker'/)
    expect(registry).toMatch(/id:\s*'section_marker'/)
    expect(registry).toMatch(/roles:\s*\[\s*'section_marker'\s*\]/)
  })

  it('renders the same component the SDK path uses, and only there', () => {
    // One entry in one registry is what stops two components drawing "a labelled
    // rule" from drifting, so the import must not be duplicated on the page.
    expect(/import SectionMarkerRow from '\.\.\/pages\/chat\/SectionMarkerRow'/.test(registry)).toBe(true)
    expect(/<SectionMarkerRow\b/.test(registry)).toBe(true)
    expect(src).not.toMatch(/<SectionMarkerRow\b/)
  })

  it('prefers meta.label over content in the entry the page resolves', () => {
    // Whitespace-tolerant: a formatter re-wrapping the JSX must not red a test
    // about which field is read.
    const flat = registry.replace(/\s+/g, ' ')
    expect(flat).toMatch(/<SectionMarkerRow[^>]*label=\{m\.meta\?\.label as string/)
    expect(flat).toMatch(/<SectionMarkerRow[^>]*fallback=\{m\.content\}/)
  })

  describe('a malformed persisted row degrades instead of crashing', () => {
    // Both call sites CAST `meta.label` to string, and a cast erases nothing at
    // runtime: these values really can arrive from the history API.
    const notStrings: [string, unknown][] = [
      ['a number', 5],
      ['an object', { toString: undefined }],
      ['an array', ['a', 'b']],
      ['a boolean', true],
    ]

    for (const [what, value] of notStrings) {
      it(`renders when the label is ${what}`, () => {
        const { container } = render(<SectionMarkerRow label={value as never} />)
        const row = container.querySelector('[data-testid="section-marker-row"]')
        expect(row).not.toBeNull()
        // Degrades to the generic caption: the row HAS a label field, so it is
        // not the older-client case that draws the raw fallback.
        expect(row?.textContent).toBe('Section break')
      })

      it(`renders when the content fallback is ${what}`, () => {
        const { container } = render(<SectionMarkerRow fallback={value as never} />)
        expect(container.querySelector('[data-testid="section-marker-row"]')).not.toBeNull()
      })
    }

    it('keeps the whole SDK transcript path alive on a malformed row', () => {
      const ctx = { row: (node: React.ReactNode) => node } as unknown as MessageRenderContext
      const bad = marker({ meta: { label: { nested: true } } } as Partial<ChatMessage>)
      const entry = resolveRenderer(bad, defaultMessageRenderers)!
      expect(entry.id).toBe('section_marker')
      const { container } = render(<>{entry.render(bad, ctx)}</>)
      expect(container.querySelector('[data-testid="section-marker-row"]')).not.toBeNull()
    })
  })
})
