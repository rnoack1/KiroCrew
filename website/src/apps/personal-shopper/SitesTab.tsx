/**
 * SitesTab — configured shopping sources with login state management.
 *
 * Sites are stored in a simple JSON file (not the sqlite store) since they're
 * few, rarely change, and don't need vector search.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Plus, Trash2 } from 'lucide-react'
import * as shopApi from './api'
import { Btn, EmptyState, Input } from '../../components/ui'

import { i18nT } from '../../i18n/t'
// ── Types ──

interface Site {
  id: string
  name: string
  url: string
  searchUrl?: string
  enabled: boolean
  loggedIn: boolean
  notes?: string
}

interface SitesData {
  sites: Site[]
}

// ── API ──

async function fetchSites(): Promise<SitesData> {
  return shopApi.get('/sites')
}

async function saveSites(data: SitesData): Promise<void> {
  await shopApi.put('/sites', data)
}

// ── Component ──

export function SitesTab() {
  const queryClient = useQueryClient()
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['personal-shopper', 'sites'],
    queryFn: fetchSites,
  })

  const mutation = useMutation({
    mutationFn: saveSites,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['personal-shopper', 'sites'] }),
  })

  const sites: Site[] = data?.sites ?? []

  const toggleSite = (id: string) => {
    const updated = sites.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s))
    mutation.mutate({ sites: updated })
  }

  const removeSite = (id: string) => {
    const updated = sites.filter((s) => s.id !== id)
    mutation.mutate({ sites: updated })
  }

  const addSite = () => {
    if (!newName.trim() || !newUrl.trim()) return
    const id = newName.trim().toLowerCase().replace(/\s+/g, '-')
    const url = newUrl.trim().startsWith('http') ? newUrl.trim() : `https://${newUrl.trim()}`
    const newSite: Site = {
      id,
      name: newName.trim(),
      url,
      enabled: true,
      loggedIn: false,
    }
    mutation.mutate({ sites: [...sites, newSite] })
    setNewName('')
    setNewUrl('')
    setShowAddForm(false)
  }

  if (isLoading) {
    return <div className="text-sm text-[var(--muted)] py-8 text-center">{i18nT('apps.personalShopper.sitesTab.loading_sites')}</div>
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--muted)]">
        {i18nT('apps.personalShopper.sitesTab.shopping_sources_the_advisor_can_browse_login_en')}
      </p>

      {/* Site list */}
      {sites.length === 0 && !showAddForm && (
        <EmptyState
          icon={<Globe size={28} />}
          title={i18nT('apps.personalShopper.sitesTab.no_sites_configured')}
          subtitle={i18nT('apps.personalShopper.sitesTab.add_your_shopping_sites_so_the_advisor_can_brows')}
        />
      )}

      {sites.map((site) => (
        <div
          key={site.id}
          className="group flex items-center gap-3 p-3 rounded-lg bg-[var(--card)] border border-[var(--border)]"
        >
          {/* Icon */}
          <div className="w-9 h-9 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] flex items-center justify-center text-base flex-shrink-0">
            <Globe size={16} className="text-[var(--muted)]" />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text)]">{site.name}</div>
            <div className="text-[11px] text-[var(--muted)] truncate">{site.url}</div>
          </div>

          {/* Login status */}
          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                site.loggedIn ? 'bg-[var(--ok)]' : 'bg-[var(--muted)]'
              }`}
            />
            <span
              className={`text-[11px] whitespace-nowrap ${
                site.loggedIn ? 'text-[var(--ok)]' : 'text-[var(--muted)]'
              }`}
            >
              {site.loggedIn
                ? i18nT('apps.personalShopper.sitesTab.logged_in')
                : i18nT('apps.personalShopper.sitesTab.not_logged_in')}
            </span>
          </div>

          {/* Toggle */}
          <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
            <input
              type="checkbox"
              checked={site.enabled}
              onChange={() => toggleSite(site.id)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-[var(--border)] peer-checked:bg-[var(--accent)] rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
          </label>

          {/* Remove (hover) */}
          <button
            onClick={() => removeSite(site.id)}
            className="opacity-0 group-hover:opacity-100 text-[var(--muted)] hover:text-[var(--danger)] transition-all flex-shrink-0"
            title={i18nT('apps.personalShopper.sitesTab.remove_site')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      {/* Add site form */}
      {showAddForm ? (
        <div className="p-3 rounded-lg bg-[var(--card)] border border-[var(--accent)] space-y-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={i18nT('apps.personalShopper.sitesTab.site_name_e_g_example_store')}
            autoFocus
          />
          <Input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder={i18nT('apps.personalShopper.sitesTab.url_e_g_store_example_com')}
            onKeyDown={(e) => { if (e.key === 'Enter') addSite() }}
          />
          <div className="flex gap-2">
            <Btn onClick={addSite} disabled={!newName.trim() || !newUrl.trim()}>
              {i18nT('apps.personalShopper.sitesTab.add_site')}
            </Btn>
            <Btn onClick={() => { setShowAddForm(false); setNewName(''); setNewUrl('') }}>
              {i18nT('apps.personalShopper.sitesTab.cancel')}
            </Btn>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
        >
          <Plus size={14} /> {i18nT('apps.personalShopper.sitesTab.add_shopping_site')}
        </button>
      )}

      {/* Info box */}
      <div className="text-[11px] text-[var(--muted)] mt-4 p-3 rounded-lg bg-[var(--bg-elevated)] leading-relaxed space-y-2">
        <p>
          <strong>{i18nT('apps.personalShopper.sitesTab.how_login_works')}</strong> {i18nT('apps.personalShopper.sitesTab.the_advisor_opens_sites_in_the_browser_panel_dur')}
        </p>
        <p>
          <strong>{i18nT('apps.personalShopper.sitesTab.privacy')}</strong> {i18nT('apps.personalShopper.sitesTab.the_advisor_only_visits_sites_you_ve_enabled_her')}
        </p>
      </div>
    </div>
  )
}
