/**
 * `truncate` is never correct on an inline `ErrorNotice`, and the reason is inheritance
 * rather than the ellipsis: the inline root is `inline-flex`, where `text-overflow` is
 * inert, while `white-space: nowrap` DOES inherit into the message span and cancels the
 * `overflow-wrap: anywhere` that span declares for itself. The message then shrinks below
 * min-content and paints over its own sibling controls instead of being clipped (#9581).
 *
 * Scanned at the source rather than rendered: the defect is a class combination across
 * many call sites, and jsdom lays nothing out, so a render proves less than the count.
 * `messageClassName="… line-clamp-1"` is the supported way to get one ellipsised line.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
const BLOCK = /<ErrorNotice\b[\s\S]*?\/>/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function inlineNoticeBlocks(): { file: string; block: string }[] {
  return sourceFiles(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf-8')
    if (!text.includes('ErrorNotice')) return []
    return [...text.matchAll(BLOCK)]
      .map((m) => m[0])
      .filter((block) => block.includes('variant="inline"'))
      .map((block) => ({ file: file.slice(SRC.length + 1), block }))
  })
}

describe('inline ErrorNotice call sites', () => {
  it('scans enough call sites for the assertion below to mean anything', () => {
    // Guards against a silent pass: a broken matcher would find nothing and "succeed".
    expect(inlineNoticeBlocks().length).toBeGreaterThan(200)
  })

  it('never passes `truncate`, whose inherited nowrap defeats the message wrap', () => {
    const offenders = inlineNoticeBlocks()
      .filter(({ block }) => /\btruncate\b/.test(block))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})
