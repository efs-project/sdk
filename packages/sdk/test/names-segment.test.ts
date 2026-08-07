/**
 * The canonical anchor-segment codec (specs/02 §"Canonical anchor-name
 * encoding") — vectors quoted from the spec, reject rules mirrored from
 * `EFSIndexer._isValidAnchorName` byte-for-byte (including the over-escape
 * rejection the contract enforces).
 */

import { describe, expect, it } from 'vitest'
import {
  InvalidAnchorNameError,
  asCanonicalName,
  decodeName,
  encodeName,
  isCanonicalName,
} from '../src/names/segment.js'

describe('encodeName — spec vectors', () => {
  it('encodes the specs/02 worked example exactly', () => {
    // specs/02: `Q&A: Episode 5` → `Q%26A%3A%20Episode%205`.
    expect(encodeName('Q&A: Episode 5')).toBe('Q%26A%3A%20Episode%205')
  })

  it('a simple name encodes to itself', () => {
    expect(encodeName('readme.txt')).toBe('readme.txt')
  })

  it('NFC-collapses composed and decomposed forms to ONE slot', () => {
    const composed = 'café' // é U+00E9
    const decomposed = 'café' // e + combining acute
    expect(encodeName(composed)).toBe(encodeName(decomposed))
    // …and the shared form keeps é as literal UTF-8 bytes, NOT %-escaped
    // (≥0x80 bytes are unreserved; encodeURIComponent would over-escape → revert).
    expect(encodeName(composed)).toBe('café')
  })

  it('escapes % itself; round-trips a literal percent', () => {
    expect(encodeName('100%')).toBe('100%25')
    expect(decodeName('100%25')).toBe('100%')
  })

  it('does NOT trim: a trailing space is a valid, distinct slot', () => {
    expect(encodeName('name ')).toBe('name%20')
  })

  it('escapes every reserved byte with UPPERCASE hex', () => {
    // C0 control, DEL, space + the URI/path-special set.
    expect(encodeName('a\x1fb')).toBe('a%1Fb')
    expect(encodeName('a\x7fb')).toBe('a%7Fb')
    for (const [ch, esc] of [
      ['"', '%22'],
      ['#', '%23'],
      ['&', '%26'],
      ['/', '%2F'],
      [':', '%3A'],
      ['=', '%3D'],
      ['?', '%3F'],
      ['@', '%40'],
      ['[', '%5B'],
      ['\\', '%5C'],
      [']', '%5D'],
      ['^', '%5E'],
      ['`', '%60'],
      ['{', '%7B'],
      ['|', '%7C'],
      ['}', '%7D'],
    ] as const) {
      expect(encodeName(`a${ch}b`), ch).toBe(`a${esc}b`)
      expect(decodeName(`a${esc}b`), esc).toBe(`a${ch}b`)
    }
  })

  it('keeps sub-delims and multi-byte UTF-8 literal', () => {
    expect(encodeName("!$'()*+,;.-_~")).toBe("!$'()*+,;.-_~")
    expect(encodeName('📁 files')).toBe('📁%20files')
  })

  it('throws on empty / . / ..', () => {
    for (const bad of ['', '.', '..']) {
      expect(() => encodeName(bad), JSON.stringify(bad)).toThrow(InvalidAnchorNameError)
    }
  })
})

describe('decode/validate — contract-mirror reject rules', () => {
  it('rejects a bare reserved byte', () => {
    expect(isCanonicalName('a&b')).toBe(false)
    expect(() => asCanonicalName('a b')).toThrow(InvalidAnchorNameError)
  })

  it('rejects lowercase-hex escapes (only %2F is canonical)', () => {
    expect(isCanonicalName('a%2fb')).toBe(false)
    expect(isCanonicalName('a%2Fb')).toBe(true)
  })

  it('rejects malformed/truncated escapes', () => {
    for (const bad of ['a%', 'a%2', 'a%ZZ']) {
      expect(isCanonicalName(bad), bad).toBe(false)
    }
  })

  it('rejects over-escapes — the contract-only rule (EFSIndexer, not in spec prose)', () => {
    // %41 = 'A', %2E = '.' — unreserved bytes must appear bare.
    expect(isCanonicalName('%41bc')).toBe(false)
    expect(isCanonicalName('a%2Eb')).toBe(false)
    // …while genuinely-reserved escapes are accepted.
    for (const ok of ['a%2Fb', 'a%20b', 'a%25b']) {
      expect(isCanonicalName(ok), ok).toBe(true)
    }
  })

  it('rejects empty / . / ..', () => {
    for (const bad of ['', '.', '..']) {
      expect(isCanonicalName(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('decodeName is strict: throws on non-canonical input', () => {
    expect(() => decodeName('a%2fb')).toThrow(InvalidAnchorNameError)
    expect(() => decodeName('a b')).toThrow(InvalidAnchorNameError)
  })
})

describe('round-trip properties', () => {
  const HUMANS = [
    'readme.txt',
    'Q&A: Episode 5',
    '100%',
    'café',
    'café',
    '📁 files/notes', // contains a reserved '/' as a NAME byte (not a separator here)
    'name ',
    'a%b',
    '%25', // a human name that LOOKS like an escape
  ]

  it('decodeName(encodeName(h)) === NFC(h) for every vector', () => {
    for (const h of HUMANS) {
      expect(decodeName(encodeName(h)), JSON.stringify(h)).toBe(h.normalize('NFC'))
    }
  })

  it('encodeName(decodeName(c)) === c for every canonical vector', () => {
    for (const h of HUMANS) {
      const c = encodeName(h)
      expect(encodeName(decodeName(c)), c).toBe(c)
    }
  })

  it('encodeName is NOT idempotent over its own output — why the brand exists', () => {
    // '100%' encodes to '100%25'; re-encoding that (as if human) yields a
    // DIFFERENT permanent slot. Sniffing cannot fix this: '100%25' is both a
    // legal human name and a legal canonical form.
    const once = encodeName('100%') as string
    const twice = encodeName(once) as string
    expect(once).toBe('100%25')
    expect(twice).toBe('100%2525')
    expect(twice).not.toBe(once)
  })
})
