import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/* ── Mock api/client BEFORE the component imports ── */
const mockApi = vi.hoisted(() => ({
  skills: vi.fn(),
  agentPatch: vi.fn(),
}))
vi.mock('../api/client', () => ({ api: mockApi }))

import AgentSkillsEditor from '../components/AgentSkillsEditor'

const CATALOG = [
  { key: 'babysit', name: 'babysit', description: 'Monitor a PR', source: 'kirocrew' },
  { key: 'kiro-user/prepare-pr', name: 'prepare-pr', description: 'Ship a PR', source: 'kiro-user' },
  { key: 'widgets', name: 'widgets', description: 'Render HTML', source: 'kirocrew' },
]

function renderEditor(props: Partial<React.ComponentProps<typeof AgentSkillsEditor>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = props.onChange ?? vi.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      <AgentSkillsEditor
        agentName={props.agentName ?? 'specialist'}
        skills={props.skills ?? []}
        unmanaged={props.unmanaged}
        onChange={onChange}
      />
    </QueryClientProvider>,
  )
  return { ...utils, onChange }
}

beforeEach(() => {
  mockApi.skills.mockReset()
  mockApi.agentPatch.mockReset()
  mockApi.skills.mockResolvedValue(CATALOG)
  mockApi.agentPatch.mockResolvedValue({ ok: true })
})

/** Open the add-skill dropdown once the catalog query has resolved. */
async function openAddMenu() {
  const btn = await screen.findByRole('button', { name: /add skill/i })
  // Add is disabled until the catalog loads (nothing to offer before then).
  await waitFor(() => expect(btn).toBeEnabled())
  fireEvent.click(btn)
}

describe('AgentSkillsEditor', () => {
  it('shows the empty state when nothing is mapped', async () => {
    renderEditor()
    expect(
      await screen.findByText(/No skills mapped/i),
    ).toBeInTheDocument()
  })

  it('renders a chip per mapped skill using its catalog display name', async () => {
    renderEditor({ skills: ['babysit', 'kiro-user/prepare-pr'] })
    // 'prepare-pr' proves the key -> catalog name lookup, not a raw key echo.
    await waitFor(() => expect(screen.getByText('prepare-pr')).toBeInTheDocument())
    expect(screen.getByText('babysit')).toBeInTheDocument()
    expect(screen.queryByText(/No skills mapped/i)).not.toBeInTheDocument()
  })

  it('adds a skill by PATCHing the full desired key list', async () => {
    const { onChange } = renderEditor({ skills: ['babysit'] })
    await openAddMenu()

    const option = await screen.findByRole('option', { name: /widgets/i })
    fireEvent.click(option)

    await waitFor(() =>
      expect(mockApi.agentPatch).toHaveBeenCalledWith('specialist', {
        skills: ['babysit', 'widgets'],
      }),
    )
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('specialist', ['babysit', 'widgets']))
  })

  it('omits already-mapped skills from the add list', async () => {
    renderEditor({ skills: ['babysit'] })
    await openAddMenu()

    await waitFor(() => expect(screen.getByRole('option', { name: /widgets/i })).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: /babysit/i })).not.toBeInTheDocument()
  })

  it('removing a chip PATCHes the remaining keys', async () => {
    renderEditor({ skills: ['babysit', 'widgets'] })
    fireEvent.click(await screen.findByRole('button', { name: /remove skill babysit/i }))

    await waitFor(() =>
      expect(mockApi.agentPatch).toHaveBeenCalledWith('specialist', { skills: ['widgets'] }),
    )
  })

  it('prefers the server-returned key list over the optimistic one', async () => {
    // The backend is authoritative: it de-dupes and drops entries it cannot
    // resolve, so the UI must adopt its answer rather than the request body.
    mockApi.agentPatch.mockResolvedValue({ ok: true, skills: ['widgets'] })
    const { onChange } = renderEditor({ skills: [] })
    await openAddMenu()
    fireEvent.click(await screen.findByRole('option', { name: /widgets/i }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('specialist', ['widgets']))
  })

  it('surfaces a rejected save instead of showing it as applied', async () => {
    mockApi.agentPatch.mockRejectedValue(new Error('unknown skills'))
    const { onChange } = renderEditor({ skills: [] })
    await openAddMenu()
    fireEvent.click(await screen.findByRole('option', { name: /widgets/i }))

    await waitFor(() => expect(screen.getByText(/no longer listed under that id/i)).toBeInTheDocument())
    expect(screen.queryByText(/unknown skills/i)).toBeNull()
    // With several chips mapped, a notice naming none of them cannot say WHICH pick failed.
    expect(screen.getByText(/widgets/)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports the agent a save was issued for, so a stale response cannot land on another agent', async () => {
    // The agent name travels with the request and comes back on the callback,
    // so the parent can drop a response that resolved after the selection moved
    // on. Without it, agent A's skills render under agent B and the next edit
    // writes them into B's spec.
    mockApi.agentPatch.mockResolvedValue({ ok: true, skills: ['widgets'] })
    const { onChange } = renderEditor({ agentName: 'agent-a', skills: [] })
    await openAddMenu()
    fireEvent.click(await screen.findByRole('option', { name: /widgets/i }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('agent-a', ['widgets']))
    expect(mockApi.agentPatch).toHaveBeenCalledWith('agent-a', { skills: ['widgets'] })
  })

  it('lists unmanaged skill:// URIs read-only with no remove control', async () => {
    renderEditor({ skills: [], unmanaged: ['skill://~/.kiro/skills/*/SKILL.md'] })
    await waitFor(() =>
      expect(screen.getByText('skill://~/.kiro/skills/*/SKILL.md')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /^Remove skill/i })).not.toBeInTheDocument()
    // A wildcard mapping is still a mapping — the empty state must not claim
    // the agent has none.
    expect(screen.queryByText(/No skills mapped/i)).not.toBeInTheDocument()
  })

  it('re-enumerates the catalog after a rejected save, so a retry cannot re-send a stale key', async () => {
    // A bundle upgrade under a live editor re-spells every package key, so the cached
    // catalog would have the retry re-send the identical rejected key.
    mockApi.agentPatch.mockRejectedValue(new Error('unknown skills'))
    renderEditor({ skills: [] })
    await waitFor(() => expect(mockApi.skills).toHaveBeenCalledTimes(1))

    await openAddMenu()
    fireEvent.click(await screen.findByRole('option', { name: /widgets/i }))

    await waitFor(() => expect(screen.getByText(/no longer listed under that id/i)).toBeInTheDocument())
    expect(screen.queryByText(/unknown skills/i)).toBeNull()
    await waitFor(() => expect(mockApi.skills.mock.calls.length).toBeGreaterThan(1))
  })

  it('renders a mapped-but-unresolved package key by its readable half, not a raw digest', async () => {
    // A stale key has no catalog row, so the chip fell back to the whole key and showed
    // a 32-hex digest to the user.
    const stale = 'package/05c564ec5e9e4b7a8c1d2e3f4a5b6c7d:shared-skill'
    mockApi.skills.mockResolvedValue([])
    renderEditor({ skills: [stale] })

    await waitFor(() => expect(screen.getByText('shared-skill')).toBeInTheDocument())
    expect(screen.queryByText(stale)).not.toBeInTheDocument()
  })

  it('disables Add when every catalog skill is already mapped', async () => {
    renderEditor({ skills: CATALOG.map(s => s.key) })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add skill/i })).toBeDisabled(),
    )
  })
})

describe('twin picker rows without a package field', () => {
  it('announces the distinguishing path, not a hex digest', async () => {
    // Deliberately NO `package` field, which is the case the edition may not supply, and
    // identical name AND description, so nothing but a disambiguator can tell them apart.
    mockApi.skills.mockResolvedValue([
      {
        key: 'package/aaaaaaaa1111111111111111111111111:shared-skill',
        name: 'shared-skill',
        description: 'A shared skill',
        source: 'package',
        path: '/editions/PkgA/skills/shared-skill/SKILL.md',
      },
      {
        key: 'package/bbbbbbbb2222222222222222222222222:shared-skill',
        name: 'shared-skill',
        description: 'A shared skill',
        source: 'package',
        path: '/editions/PkgB/skills/shared-skill/SKILL.md',
      },
    ])
    renderEditor({ skills: [] })
    await openAddMenu()

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)

    const announced = options.map(o => (o.textContent ?? '').trim())
    // Non-vacuity: both rows must really carry the shared name, or the fixture is not the
    // twin case this pins.
    expect(announced.every(t => t.includes('shared-skill'))).toBe(true)
    expect(new Set(announced).size).toBe(2)
    // The readable location is what a person can act on; a bare 8-hex tail is not.
    expect(announced.some(t => t.includes('PkgA'))).toBe(true)
    expect(announced.some(t => t.includes('PkgB'))).toBe(true)
    for (const t of announced) {
      expect(t).not.toMatch(/\b[0-9a-f]{8}\b/)
    }
  })
})

describe('an unresolved mapping', () => {
  it('signals by an icon, not by colour alone', async () => {
    const { container } = renderEditor({ skills: ['package/deadbeefcafe1234:gone-skill'] })
    await waitFor(() => expect(mockApi.skills).toHaveBeenCalled())
    // lucide renders an svg per icon and tags it with its own name, so the alert icon's
    // presence is checkable without asserting on colour classes.
    await waitFor(() =>
      expect(container.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle'))
        .not.toBeNull()
    )
  })
})

describe('a mapped chip while the catalog is still unknown', () => {
  it('does not claim not-installed until the query has succeeded', async () => {
    let release: (rows: unknown[]) => void = () => {}
    mockApi.skills.mockReturnValue(new Promise(res => { release = res as typeof release }))
    renderEditor({ skills: ['widgets'] })

    // The catalog is in flight: an empty list here is not evidence the skill is gone.
    await waitFor(() => expect(screen.getByText('widgets')).toBeInTheDocument())
    expect(screen.queryByText(/not currently installed/i)).toBeNull()

    release(CATALOG)
    await waitFor(() => expect(mockApi.skills).toHaveBeenCalled())
  })
})

describe('the rejection notice', () => {
  it('names the key the backend refused, not whatever was last attempted', async () => {
    // The refusal is whole-PATCH, so on an ADD the offender can be a DIFFERENT stale key
    // than the one just picked -- a notice keyed on the attempt would name the wrong skill.
    mockApi.agentPatch.mockRejectedValue(new Error('unknown skills: kiro-user/prepare-pr'))
    renderEditor({ skills: ['kiro-user/prepare-pr'] })
    await openAddMenu()
    fireEvent.click(await screen.findByRole('option', { name: /widgets/i }))

    await waitFor(() =>
      expect(screen.getByText(/no longer listed under that id/i)).toBeInTheDocument()
    )
    const notice = screen.getByText(/no longer listed under that id/i).textContent ?? ''
    expect(notice).toContain('prepare-pr')
    expect(notice).not.toContain('widgets')
    expect(notice.trimStart().startsWith(':')).toBe(false)
  })
})

describe('a name shared with a non-package skill', () => {
  it('is not treated as a colliding copy', async () => {
    // The qualifier exists for colliding BUNDLES. A user's own copy of a crew skill shares
    // the name without being an ambiguity, so tagging it would be noise.
    mockApi.skills.mockResolvedValue([
      { key: 'babysit', name: 'babysit', description: 'Monitor a PR', source: 'kirocrew' },
      {
        key: 'kiro-user/babysit',
        name: 'babysit',
        description: 'Monitor a PR',
        source: 'kiro-user',
        path: '/home/u/.kiro/crew/skills/babysit/SKILL.md',
      },
    ])
    renderEditor({ skills: [] })
    await openAddMenu()

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    for (const o of options) {
      expect(o.textContent ?? '').not.toContain('.kiro/crew')
    }
  })
})

describe('an unresolved mapping', () => {
  it('states the reason in visible text, not only a hover title', async () => {
    renderEditor({ skills: ['package/deadbeefcafe1234:gone-skill'] })
    await waitFor(() => expect(mockApi.skills).toHaveBeenCalled())
    // A `title`/`aria-label` reaches a mouse and a screen reader; a sighted keyboard or
    // touch user sees only the colour and the icon without this.
    await waitFor(() =>
      expect(screen.getByText(/not currently installed/i)).toBeInTheDocument()
    )
  })
})

describe('a refused REMOVAL', () => {
  it('says what to remove, not to pick again', async () => {
    mockApi.agentPatch.mockRejectedValue(new Error('unknown skills: kiro-user/prepare-pr'))
    renderEditor({ skills: ['babysit', 'kiro-user/prepare-pr'] })
    await waitFor(() => expect(mockApi.skills).toHaveBeenCalled())

    const removes = await screen.findAllByRole('button', { name: /remove skill/i })
    fireEvent.click(removes[0])

    await waitFor(() =>
      expect(screen.getByText(/prepare-pr: .*not currently installed/i)).toBeInTheDocument()
    )
    // The add-branch copy must NOT be what a removal shows.
    expect(screen.queryByText(/no longer listed under that id/i)).toBeNull()
  })
})
