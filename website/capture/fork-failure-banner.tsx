/**
 * Evidence for the fork-failure banner this PR introduces.
 *
 * THE CHANGE: a failed fork already rendered through `ErrorNotice` on the page's SHARED
 * `action-error` slot, but that slot could not carry a structured report. It now can, so
 * the fork keeps code-specific copy and the agent hand-off on the notice already there.
 *
 * Both copies are covered, since different failures reach them:
 *   ?scene=too-large   the over-capacity refusal (backend `fork_corpus_too_large`)
 *   ?scene=generic     any other fork failure, carrying the raw wire message
 *   ?theme=dark|light  ?direction=head|tail
 *
 * The notice is the REAL component and the strings come from the live i18n catalog, so a
 * frame proves the copy AND where the banner lands relative to the composer.
 */
import { createRoot } from 'react-dom/client'

import ErrorNotice from '../src/components/ErrorNotice'
import { initI18n } from '../src/i18n/all'
import { i18nT } from '../src/i18n/t'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') === 'generic' ? 'generic' : 'too-large'
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
const direction = params.get('direction') === 'tail' ? 'tail' : 'head'

document.documentElement.dataset.mode = theme
document.documentElement.dataset.theme = theme === 'light' ? 'kiro-light' : 'kiro-dark'

initI18n()

// Mirrors forkErrorNotice's branch: the over-capacity code gets direction-specific
// copy, every other failure falls through to the generic one with the wire message.
const message =
  scene === 'too-large'
    ? i18nT(
        direction === 'tail'
          ? 'pages.chatPage.fork_too_large_error_tail'
          : 'pages.chatPage.fork_too_large_error_head',
      )
    : i18nT('pages.chatPage.fork_failed_error', { error: 'slot is closed' })

function Scene() {
  return (
    <div className="flex h-screen flex-col bg-canvas text-body" data-capture-root>
      <div className="flex-1 overflow-hidden px-4 pt-4">
        <div className="mb-3 text-sm text-muted">Earlier in this conversation…</div>
        <div className="mb-2 rounded-lg bg-surface p-3 text-sm">
          Can you fork this from the message where we changed the schema?
        </div>
        <div className="mb-2 rounded-lg p-3 text-sm">
          Forking from there now.
        </div>
      </div>

      {/* The banner's real position: between the transcript tail and the composer. */}
      <ErrorNotice
        message={message}
        onDismiss={() => undefined}
        variant="block"
        askAgent
        className="mx-4 mt-2 mb-0"
        testId="action-error"
      />

      <div className="p-4">
        <div className="rounded-xl border border-subtle bg-surface p-3">
          <div className="text-sm text-muted">Send a message…</div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Scene />)
