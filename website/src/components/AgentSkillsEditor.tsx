import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { AlertTriangle, Brain, ChevronDown, Lock, Plus, X } from 'lucide-react'
import { api } from '../api/client'
import { Btn, Input } from './ui'
import InfoTip from './InfoTip'
import { useFilteredDropdown } from '../hooks/useFilteredDropdown'
import { useListboxKeyboard } from '../hooks/useListboxKeyboard'

import { i18nT } from '../i18n/t'
import ErrorNotice from './ErrorNotice'
/** A row from `GET /api/skills` — only the fields this editor needs. */
export interface CatalogSkill {
  key: string
  name: string
  description?: string
  source?: string
  /** Absolute path to the row's SKILL.md. */
  path?: string
  /** The bundle that vends this row. Part of the documented row contract, and the
   *  readable answer to WHICH copy -- so it is used rather than re-derived from `path`. */
  package?: string
}

/**
 * `package/<digest>:<rel>` — the qualifier is what makes one of several colliding copies
 * addressable. It is read here to recover the READABLE half of a mapped key: a key whose
 * copy is no longer enumerated has no catalog row, so the raw key would render as a bare
 * 32-hex digest.
 *
 * No bundle NAME is rendered beside it, deliberately. `GET /api/skills` re-keys a colliding
 * package row onto its qualified spelling, so such a copy DOES reach the picker under its own
 * key -- but the qualifier is a digest, not a name, and the readable disambiguator is the
 * package field the row already carries, which is also what an origin span would have shown.
 */
const QUALIFIED_PACKAGE_KEY = /^package\/([0-9a-f]{8,}):(.+)$/

function splitQualifiedKey(key: string): { digest: string; rel: string } | null {
  const m = QUALIFIED_PACKAGE_KEY.exec(key)
  return m ? { digest: m[1], rel: m[2] } : null
}

/**
 * The save mutation's variables, declared ONCE.
 *
 * Annotating only one handler's parameter narrows react-query's inferred `TVariables` to
 * that shape, which then contradicts the others -- the compile error this alias prevents.
 */
interface SaveVars {
  agent: string
  next: string[]
  attempted?: string
  /** Which action issued the write, so a refusal can say what to do about it. */
  intent?: 'add' | 'remove'
}

/**
 * The readable part of a colliding copy's location: the directories ABOVE the skill's own
 * name, last two only.
 *
 * Two copies of one skill differ by where their bundle lives, so those segments are what a
 * person can act on. A digest is unique but says nothing about which copy is which, and a
 * full path is too long for a picker row.
 */
/**
 * The first skill key the backend named as unknown, from its error detail.
 *
 * The refusal is whole-PATCH, so the offender is not necessarily the key this call added --
 * and a removal adds none at all. Reading it from the detail is what lets the notice name
 * the skill that actually blocked the write.
 */
function refusedKeyFrom(detail: string): string | null {
  const m = /unknown skills?:\s*([^\s,]+)/i.exec(detail)
  return m ? m[1] : null
}

function pathTail(path: string | undefined, name: string): string | null {
  if (!path) return null
  const parts = path.split('/').filter(p => p && p !== name && !p.endsWith('.md'))
  // A trailing `skills` is the same for every root, so keeping it inside the two-segment
  // window can spend the whole disambiguator on a constant and render twins identically.
  while (parts.length > 1 && parts[parts.length - 1] === 'skills') parts.pop()
  return parts.length ? parts.slice(-2).join('/') : null
}

interface Props {
  /** Agent template name (the `{name}` in `/api/agents/detail/{name}`). */
  agentName: string
  /** Catalog keys currently mapped via the agent's `skill://` resources. */
  skills: string[]
  /**
   * `skill://` URIs the catalog cannot express — wildcard patterns and paths
   * outside every known skill root. Shown read-only: the backend preserves them
   * across writes, so listing them here explains why an agent may load more
   * than the editable chips suggest.
   */
  unmanaged?: string[]
  /**
   * Called after a successful save with the agent the save was issued FOR and
   * its new key list. The name is passed back because a slow PATCH can resolve
   * after the user has selected a different agent — the caller must ignore a
   * response that no longer matches what is on screen, or agent A's skills land
   * on agent B and the next edit writes them to B's spec.
   */
  onChange: (agentName: string, skills: string[]) => void
}

/**
 * Add/remove the skills an agent template maps.
 *
 * Writes through `PATCH /api/agents/detail/{name}` with `{ skills: [...] }`,
 * which the backend materializes as kiro-cli-native `skill://` entries in the
 * agent's `resources`. Each edit saves immediately (same interaction model as
 * the model picker on this page) — there is no separate Save button to forget.
 */
export default function AgentSkillsEditor({ agentName, skills, unmanaged = [], onChange }: Props) {
  const [error, setError] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()

  const { data: catalog = [], isSuccess: catalogLoaded } = useQuery<CatalogSkill[]>({
    queryKey: ['skills-catalog'],
    queryFn: async () => {
      const rows = await api.skills()
      return Array.isArray(rows) ? (rows as CatalogSkill[]).filter(s => s?.key) : []
    },
    staleTime: 30_000,
  })

  const byKey = useMemo(() => {
    const m = new Map<string, CatalogSkill>()
    for (const s of catalog) m.set(s.key, s)
    return m
  }, [catalog])

  // How many catalog rows share each display name. Only a name carried by more than
  // one row needs its qualifier shown, so an ordinary skill stays a plain label.
  // Counted over PACKAGE rows only: the qualifier exists for colliding bundles, so a
  // user's own copy sharing a crew skill's name is not an ambiguity and needs no tail.
  const nameCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of catalog) {
      if (s.source !== 'package') continue
      m.set(s.name, (m.get(s.name) ?? 0) + 1)
    }
    return m
  }, [catalog])

  // Counted here rather than inside the chip loop so the visible note is rendered ONCE
  // however many mapped copies are missing.
  const unresolvedCount = useMemo(
    () => (catalogLoaded ? skills.filter(k => !byKey.get(k)).length : 0),
    [catalogLoaded, skills, byKey]
  )

  // Candidates = catalog minus what's already mapped, name-sorted for a stable
  // list regardless of the catalog's source-grouped order.
  const candidates = useMemo(
    () => catalog.filter(s => !skills.includes(s.key)).sort((a, b) => a.name.localeCompare(b.name)),
    [catalog, skills],
  )

  const { open, setOpen, filter, setFilter, dropdownRef, inputRef, filtered } =
    useFilteredDropdown(candidates)

  const save = useMutation({
    // The agent name travels WITH the request so the response can be matched to
    // the agent it was issued for, not to whatever is selected when it lands.
    mutationFn: ({ agent, next }: SaveVars) => api.agentPatch(agent, { skills: next }),
    onMutate: () => setError(''),
    onSuccess: (res: { skills?: string[] }, { agent, next }: SaveVars) =>
      onChange(agent, res?.skills ?? next),
    onError: (e: unknown, vars: SaveVars) => {
      const detail = e instanceof Error ? e.message : String(e)
      // The backend says the same thing for a re-keyed skill and one uninstalled outright,
      // so the notice asserts only what IS known and does not promise a re-pick will work.
      const unlisted = /unknown skills/i.test(detail)
      // The whole PATCH is refused when any key is stale, so the offender is often not what
      // this call attempted -- and a removal attempts none. Read it from the detail first.
      const refused = refusedKeyFrom(detail)
      const offender = refused
        ? catalog.find(c => c.key === refused)?.name ||
          splitQualifiedKey(refused)?.rel ||
          refused
        : vars.attempted
      // A removal must not be told to "pick this skill again" -- it names the wrong action
      // and the user chose no id. Both strings below already ship in every locale.
      const named = offender ?? ''
      setError(
        unlisted
          ? vars.intent === 'remove'
            ? `${named}: ${i18nT('components.agentSkillsEditor.mapping_unresolved')}`.trimStart()
            : i18nT('components.agentSkillsEditor.key_changed_repick', { name: named })
          : detail
      )
      // The catalog in hand is the stale one that minted the refused key, and it is
      // cached, so without this a retry re-sends exactly the key that was just rejected.
      if (unlisted) void queryClient.invalidateQueries({ queryKey: ['skills-catalog'] })
    },
  })

  const add = (key: string) => {
    setOpen(false)
    // The refused key's readable label, so the failure notice can name WHICH pick failed.
    const picked = candidates.find(c => c.key === key)
    save.mutate({
      agent: agentName,
      next: [...skills, key],
      attempted: picked?.name || key,
    })
  }
  const remove = (key: string) =>
    save.mutate({ agent: agentName, next: skills.filter(k => k !== key), intent: 'remove' })

  const { onListKeyDown } = useListboxKeyboard({
    open,
    dropdownRef,
    inputRef,
    hasFilterInput: true,
    filteredCount: filtered.length,
    onEnterSingleMatch: () => add(filtered[0].key),
    closeToTrigger: () => { setOpen(false); btnRef.current?.focus() },
  })

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[12px] text-muted font-medium uppercase tracking-wider">{i18nT('components.agentSkillsEditor.skills')}</span>
        <InfoTip text={i18nT('components.agentSkillsEditor.skills_this_agent_template_loads_written_as_skil')} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {skills.map(key => {
          const skill = byKey.get(key)
          const qualified = splitQualifiedKey(key)
          // An unresolved key has no catalog row to name it, so the raw key would render
          // as a 32-hex digest; its rel half is the readable part.
          const label = skill?.name || qualified?.rel || key
          // No catalog row means the mapped copy is not installed NOW, and the ordinary
          // style made that dead mapping look healthy. Gated on the query having SUCCEEDED:
          // an empty catalog while loading or after a failure is not evidence of absence.
          const unresolved = catalogLoaded && !skill
          const unresolvedNote = i18nT('components.agentSkillsEditor.mapping_unresolved')
          const ambiguous = skill
            ? skill.source === 'package' && (nameCounts.get(skill.name) ?? 0) > 1
            : Boolean(qualified)
          // The user picked by PATH, so the chip says the same thing the picker row did.
          // A digest is unique but cannot be correlated back to that choice, so it is last.
          const disambiguator =
            skill?.package ||
            (skill ? pathTail(skill.path, skill.name) : null) ||
            (qualified ? qualified.digest.slice(0, 8) : null)
          return (
            <span
              key={key}
              className={`group inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full text-[12px] font-mono ${
                unresolved
                  ? 'bg-warn-subtle border border-warn text-warn-fg'
                  : 'bg-accent-subtle border border-accent/30 text-text'
              }`}
              // A qualified key leads with a 32-hex digest, so the readable label comes
              // first on every chip and the key follows it as the precise form.
              title={
                unresolved
                  ? `${unresolvedNote}\n${key}`
                  : skill?.description
                    ? `${skill.description}\n${key}`
                    : `${label}\n${key}`
              }
              // A screen reader would otherwise spell the whole 32-hex qualifier, so the
              // name carries the readable label plus the short id the chip already shows.
              aria-label={
                [label, disambiguator, unresolved ? unresolvedNote : skill?.description]
                  .filter(Boolean)
                  .join(' ') || label
              }
            >
              {unresolved ? (
                <AlertTriangle className="lucide-inline text-warn-fg" />
              ) : (
                <Brain className="lucide-inline" />
              )}
              {label}
              {ambiguous && disambiguator && (
                <span
                  className="text-muted text-[10px]"
                  // A `title` on a non-focusable span reaches a mouse only, so the hint is
                  // also emitted as text a screen reader and keyboard user can reach.
                  title={i18nT('components.agentSkillsEditor.copy_identifier_hint')}
                >
                  {disambiguator}
                  <span className="sr-only">
                    {' '}
                    {i18nT('components.agentSkillsEditor.copy_identifier_hint')}
                  </span>
                </span>
              )}
              <button
                className="text-muted hover:text-danger-fg hover:bg-danger rounded-full px-0.5 transition-colors disabled:opacity-40"
                title={i18nT('components.agentSkillsEditor.remove', { name: label })}
                aria-label={i18nT('components.agentSkillsEditor.remove_skill', { name: label })}
                disabled={save.isPending}
                onClick={() => remove(key)}
              >
                <X className="lucide-inline" />
              </button>
            </span>
          )
        })}
        {unmanaged.map(uri => (
          <span
            key={uri}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[12px] font-mono bg-bg-elevated border border-border text-muted"
            title={i18nT('components.agentSkillsEditor.edit_agent_config_to_change_mapping', { path: uri })}
          >
            <Lock className="lucide-inline" />
            {uri}
          </span>
        ))}
        <div className="relative">
          <Btn
            ref={btnRef}
            className="flex items-center gap-1 px-2 py-1 text-[12px]"
            disabled={save.isPending || candidates.length === 0}
            onClick={() => setOpen(!open)}
          >
            <Plus className="lucide-inline" /> {i18nT('components.agentSkillsEditor.add_skill')}
            <span className="text-muted text-[10px]"><ChevronDown className="lucide-inline" /></span>
          </Btn>
          {open && btnRef.current && createPortal(
            // Presentational positioning wrapper: interactive semantics live on
            // the inner role="listbox" and its option buttons, so this element
            // only hosts the roving-focus keydown handler (mirrors the model
            // dropdown on this page).
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <div
              ref={dropdownRef}
              tabIndex={-1}
              onKeyDown={onListKeyDown}
              className="fixed z-[9999] bg-card border border-border rounded-lg shadow-lg min-w-[280px] max-w-[380px] max-h-[320px] flex flex-col overflow-hidden animate-slide-up"
              style={(() => {
                const r = btnRef.current!.getBoundingClientRect()
                const dropH = 320
                const top = r.bottom + 4 + dropH > window.innerHeight ? r.top - dropH - 4 : r.bottom + 4
                const left = Math.max(8, Math.min(r.left, window.innerWidth - 388))
                return { top, left }
              })()}
            >
              <div className="p-2 border-b border-border">
                <Input
                  ref={inputRef}
                  type="text"
                  aria-label={i18nT('components.agentSkillsEditor.filter_skills')}
                  placeholder={i18nT('components.agentSkillsEditor.type_to_filter')}
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  className="w-full px-2 py-1 text-[13px]"
                />
              </div>
              <div role="listbox" aria-label={i18nT('components.agentSkillsEditor.available_skills')} className="overflow-y-auto flex-1 min-h-0 p-1">
                {filtered.length === 0 ? (
                  <div className="px-2 py-3 text-[12px] text-muted text-center">{i18nT('components.agentSkillsEditor.no_matching_skills')}</div>
                ) : filtered.map(s => {
                  // A repeated PACKAGE name makes two rows visual twins, so the
                  // disambiguator is rendered INSIDE the button, where it is announced.
                  const twin = s.source === 'package' && (nameCounts.get(s.name) ?? 0) > 1
                  const tail = twin ? s.package || pathTail(s.path, s.name) || s.key : null
                  return (
                    <button
                      key={s.key}
                      role="option"
                      aria-selected={false}
                      tabIndex={-1}
                      title={s.path ? `${s.path}\n${s.key}` : s.key}
                      className="w-full text-left px-2 py-1.5 rounded-md hover:bg-bg-hover focus-ring transition-colors"
                      onClick={() => add(s.key)}
                    >
                      <span className="block text-[13px] font-mono text-text truncate">{s.name}</span>
                      {s.description && (
                        <span className="block text-[11px] text-muted truncate">{s.description}</span>
                      )}
                      {/* Twins share name AND description, so the deciding text sits in the
                          description slot rather than the faintest line on the row. */}
                      {tail && (
                        <span className="block text-[11px] font-mono text-muted truncate">{tail}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>,
            document.body
          )}
        </div>
      </div>
      {skills.length === 0 && unmanaged.length === 0 && (
        <div className="text-[11px] text-muted mt-1.5">
          {i18nT('components.agentSkillsEditor.no_skills_mapped_this_agent_uses_the_default_beh')}
        </div>
      )}
      {/* Visible, not only a `title` and an aria-label: a sighted keyboard or touch user
          otherwise sees a yellow chip and a triangle and is told nothing. */}
      {unresolvedCount > 0 && (
        <div className="text-[11px] text-warn-fg mt-1.5">
          {i18nT('components.agentSkillsEditor.mapping_unresolved')}
        </div>
      )}
      {/* No hand-off: the notice sits beside unsaved form input, and the button
          navigates away — which would discard what the user typed. */}
      <ErrorNotice message={error} className="mt-1.5" />
    </div>
  )
}
