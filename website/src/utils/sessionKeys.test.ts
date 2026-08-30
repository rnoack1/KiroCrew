import { describe, it, expect } from 'vitest'

import { sessionKeyFrom, sessionKeyFromChatHref } from './sessionKeys'

describe('sessionKeyFrom', () => {
  it('reads a bare slot key', () => {
    expect(sessionKeyFrom('chat-24-1784661951')).toBe('chat-24-1784661951')
  })

  it('strips the dashboard_ prefix of the resumed spelling', () => {
    // History files are `dashboard_chat-<n>-<ts>.jsonl`, so an agent that listed
    // transcripts writes this form; it must resolve to the same slot key.
    expect(sessionKeyFrom('dashboard_chat-24-1784661951')).toBe('chat-24-1784661951')
  })

  it('trims surrounding whitespace', () => {
    expect(sessionKeyFrom('  chat-7-1700000000\n')).toBe('chat-7-1700000000')
  })

  it.each([
    ['chat-24', 'no timestamp'],
    ['chat--1784661951', 'no slot number'],
    ['chat-24-', 'empty timestamp'],
    ['chat-abc-1784661951', 'non-numeric slot'],
    ['chat-24-17846x1951', 'non-numeric timestamp'],
    ['session-24-1784661951', 'wrong prefix'],
    ['', 'empty string'],
  ])('refuses %s (%s)', (raw) => {
    expect(sessionKeyFrom(raw)).toBeNull()
  })

  it('refuses a key that is only PART of the span', () => {
    // The regex is anchored at both ends on purpose. A loose match would chip a
    // span whose visible text says one thing while the target says another.
    expect(sessionKeyFrom('see chat-24-1784661951 for details')).toBeNull()
    expect(sessionKeyFrom('chat-24-1784661951.jsonl')).toBeNull()
    expect(sessionKeyFrom('xchat-24-1784661951')).toBeNull()
  })
})

describe('sessionKeyFromChatHref', () => {
  it('reads the canonical deep link', () => {
    expect(sessionKeyFromChatHref('/chat?sid=chat-24-1784661951')).toBe('chat-24-1784661951')
  })

  it('reads the legacy ?slot= alias', () => {
    // ChatPage itself still honours `?slot=`, so refusing it here would chip only
    // half the links that actually work.
    expect(sessionKeyFromChatHref('/chat?slot=chat-9-1700000000')).toBe('chat-9-1700000000')
  })

  it('tolerates the cosmetic title slug', () => {
    expect(sessionKeyFromChatHref('/chat/fix-the-pagination-bug?sid=chat-24-1784661951'))
      .toBe('chat-24-1784661951')
  })

  it('survives extra query parameters in any order', () => {
    expect(sessionKeyFromChatHref('/chat?tab=activity&sid=chat-3-1699999999')).toBe('chat-3-1699999999')
  })

  it('accepts the dashboard_ spelling inside the query', () => {
    expect(sessionKeyFromChatHref('/chat?sid=dashboard_chat-24-1784661951')).toBe('chat-24-1784661951')
  })

  it('refuses an absolute URL even when its path and query would match', () => {
    // A chip promises to stay inside THIS dashboard. Honouring a foreign origin
    // would retarget that promise without changing how the chip looks.
    expect(sessionKeyFromChatHref('https://elsewhere.example/chat?sid=chat-24-1784661951')).toBeNull()
    expect(sessionKeyFromChatHref('http://localhost:5476/chat?sid=chat-24-1784661951')).toBeNull()
  })

  it('refuses a protocol-relative href, which reads local but resolves foreign', () => {
    expect(sessionKeyFromChatHref('//elsewhere.example/chat?sid=chat-24-1784661951')).toBeNull()
  })

  it.each([
    ['/chat', 'no key at all'],
    ['/chat?sid=', 'empty key'],
    ['/chat?sid=nonsense', 'key fails the grammar'],
    ['/chats?sid=chat-24-1784661951', 'sibling path, not /chat'],
    ['/artifacts/foo?sid=chat-24-1784661951', 'a different route carrying sid'],
    ['/chatter?sid=chat-24-1784661951', 'prefix collision on the path'],
  ])('refuses %s (%s)', (href) => {
    expect(sessionKeyFromChatHref(href)).toBeNull()
  })

  it('refuses a bare key that is not a link', () => {
    // The two readers are deliberately separate: a key in prose is not an href,
    // and treating one as the other is how a chip ends up with no target.
    expect(sessionKeyFromChatHref('chat-24-1784661951')).toBeNull()
  })
})
