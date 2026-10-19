/**
 * Capture entry for the rewritten-row cue: the REAL `UserMessage` and `MarkdownRenderer`,
 * gated below so a raw i18n key cannot pass as a green screenshot. Three rows, because the
 * question is a COMPARISON: rewritten, verbatim, withheld. Theme: ?theme=dark|light
 */
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { initI18n } from '../src/i18n/all'
import { i18nT } from '../src/i18n/t'
import UserMessage from '../src/pages/chat/UserMessage'
import MarkdownRenderer from '../src/components/MarkdownRenderer'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'kiro-light' : 'kiro-dark'
document.documentElement.setAttribute('data-theme', theme)

initI18n('en')

/** What a persister writes once the scrub rewrites a span; no original is kept. */
const REWRITTEN = 'deploy with token [REDACTED: credential] and retry the failed shard'
/** Same shape of request, nothing scrubbed -- the contrast row. */
const VERBATIM = 'deploy with the staging profile and retry the failed shard'
/** A miscomposed companion policy withholds the body; the backend cues that too. */
const WITHHELD = '<withheld: redaction unavailable>'

const render = (c: string) => <MarkdownRenderer content={c} softBreaks />

/** The literal per-row transcript wrapper and user-row chain. */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 mx-auto w-full py-1" style={{ maxWidth: 'var(--mc-content-width, 900px)' }}>
      <div className="group flex flex-col min-w-0 items-end">
        <div className="flex flex-col gap-0.5 min-w-0 overflow-hidden max-w-full items-end">
          {children}
        </div>
      </div>
    </div>
  )
}

/** The three rows in document order, which `__captureGate` reads by cue index. */
const ROWS = [
  { content: REWRITTEN, redacted: true, at: '3:41 PM' },
  { content: VERBATIM, redacted: false, at: '3:42 PM' },
  { content: WITHHELD, redacted: true, at: '3:43 PM' },
]

function Scene() {
  return (
    <div className="bg-bg text-text min-h-screen py-6" data-capture-root>
      {ROWS.map(({ content, redacted, at }, i) => (
        <Row key={i}>
          <UserMessage content={content} redacted={redacted} messageTs={`row-${i}`} timestamp={at} timestampTitle={`Wednesday, September 16, 2026 at ${at}`} renderContent={render} />
        </Row>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<MemoryRouter><Scene /></MemoryRouter>)

declare global {
  interface Window {
    __captureGate: () => { cueText: string; cueCount: number }
  }
}

window.__captureGate = () => {
  const cues = document.querySelectorAll('[data-testid="user-message-redacted"]')
  const cueText = (cues[0]?.textContent || '').trim()
  const withheldText = (cues[1]?.textContent || '').trim()
  const expected = i18nT('pages.chat.userMessage.row_redacted')
  const expectedWithheld = i18nT('pages.chat.userMessage.row_withheld')
  if (cues.length !== 2) {
    throw new Error(`capture gate: expected two cues, saw ${cues.length}`)
  }
  if (cueText !== expected || cueText.includes('userMessage.')) {
    throw new Error(`capture gate: cue reads ${JSON.stringify(cueText)}, expected ${JSON.stringify(expected)}`)
  }
  // startsWith, not equality: the withheld cue is an ErrorNotice, which may append its
  // own hand-off control's label inside the same element.
  if (!withheldText.startsWith(expectedWithheld) || withheldText === cueText) {
    throw new Error(`capture gate: withheld cue reads ${JSON.stringify(withheldText)}, expected ${JSON.stringify(expectedWithheld)}`)
  }
  if (!document.body.textContent?.includes(WITHHELD)) {
    throw new Error('capture gate: the withheld row body is not on the page')
  }
  return { cueText, cueCount: cues.length }
}
