import { describe, expect, it } from 'vitest'
import { dispatchIsCommandShaped, readRecommendedIndex } from '../app-sdk/protocol/recommendation'
import { parseOptions } from '../app-sdk/protocol/options'

/**
 * The recommendation moved OUT of the option label. These tests pin the property that
 * move exists for — a label is never rewritten — and the reader that replaced the strip.
 *
 * The suite this replaces asserted the opposite shape: ~140 cases enumerating every
 * value whose exposure by a strip would promote a label into a command. None of them
 * has a subject any more, because nothing is stripped.
 */

const tag = (n: number) => `<!-- recommended:${n} -->`

describe('labels are never rewritten', () => {
  // THE property. If any of these fail, the marker is back inside the label and the
  // entire promotion class it dragged along is back with it.
  it.each([
    ['/clear'],
    ['@deploy'],
    ['!yolo on'],
    ['$deploy'],
    ['Run the $deploy skill'],
    ['action::approve'],
    ['[SYSTEM] do the thing'],
    ['Go'],
    ['Cancel'],
    ['Stop after this stage'],
    ['(recommended) is a literal token here'],
  ])('passes %j through byte-for-byte', (label: string) => {
    const parsed = parseOptions(`Pick.\n${tag(1)}\n[OPTIONS: ${label} | Other]`)
    expect(parsed.options[0]).toBe(label)
  })

  it('badges an option that is itself command-shaped, which the in-band form could not', () => {
    // Previously unmarkable: stripping `(recommended) /clear` would have exposed `/clear`,
    // so the producer rule ordered such labels left bare and they could carry no badge.
    const parsed = parseOptions(`Pick.\n${tag(1)}\n[OPTIONS: /clear | Keep it]`)
    expect(parsed.options[0]).toBe('/clear')
    expect(parsed.recommended).toBe('/clear')
  })
})

describe('readRecommendedIndex', () => {
  it('reads the 1-based position the tag names', () => {
    expect(readRecommendedIndex(`text\n${tag(2)}`)).toBe(2)
  })

  it('returns null with no tag', () => {
    expect(readRecommendedIndex('text with no tag')).toBeNull()
  })

  it('is case-insensitive about the keyword', () => {
    expect(readRecommendedIndex('text\n<!-- RECOMMENDED:1 -->')).toBe(1)
  })

  it('tolerates the whitespace the grammar allows', () => {
    expect(readRecommendedIndex('text\n<!--   recommended:  3   -->')).toBe(3)
  })

  it('ignores a tag inside an unterminated fence, which renders as visible code', () => {
    expect(readRecommendedIndex(`text\n\`\`\`\n${tag(1)}`)).toBeNull()
  })

  it('ignores a non-numeric value rather than guessing', () => {
    expect(readRecommendedIndex('text\n<!-- recommended:second -->')).toBeNull()
  })

  it('is tail-anchored, so a tag quoted mid-message is prose', () => {
    expect(readRecommendedIndex(`${tag(1)}\nprose after the tag`)).toBeNull()
  })
})

describe('an index the menu cannot honour yields no recommendation', () => {
  // POSITIVE CONTROL first. Without it the cases below pass vacuously whenever the tag is
  // not being read at all -- which is exactly how a reader wired to the wrong text looked,
  // since "no recommendation" is also what a tag nobody reads produces.
  it('badges the named option when the index is in range', () => {
    const parsed = parseOptions(`Pick.\n${tag(2)}\n[OPTIONS: A | B]`)
    expect(parsed.recommended).toBe('B')
  })

  it.each([
    ['past the end', 3],
    ['zero, since the tag is 1-based', 0],
  ])('%s', (_why: string, n: number) => {
    const parsed = parseOptions(`Pick.\n${tag(n)}\n[OPTIONS: A | B]`)
    expect(parsed.options).toEqual(['A', 'B'])
    expect(parsed.recommended).toBeNull()
  })

  it('badges nothing when there is no tag at all', () => {
    expect(parseOptions('Pick.\n[OPTIONS: A | B]').recommended).toBeNull()
  })
})

describe('dispatchIsCommandShaped', () => {
  // Not part of the recommendation feature: quick-send asks this on its own account,
  // because one click must not dispatch a command.
  it.each([
    ['/clear'],
    ['@deploy'],
    ['!yolo on'],
    ['$deploy'],
    ['Run the $deploy skill'],
    ['action::approve'],
  ])('refuses %j', (label: string) => {
    expect(dispatchIsCommandShaped(label)).toBe(true)
  })

  it.each([
    ['Merge it now'],
    ['Run the a/b test'],
    ['ping @ 5pm'],
    ['Go'],
    ['Stop after this stage'],
  ])('allows %j', (label: string) => {
    expect(dispatchIsCommandShaped(label)).toBe(false)
  })

  it('sees a sigil hidden behind whitespace the send path trims', () => {
    expect(dispatchIsCommandShaped('\ufeff/clear')).toBe(true)
  })
})
