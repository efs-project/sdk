import { describe, expect, it } from 'vitest'
import { hashContent, verifyContent } from '../src/content/hash.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('content hashing (ADR-0006: bare SHA-256)', () => {
  it('matches known SHA-256 vectors (byte-identical to sha256sum)', () => {
    expect(hashContent(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(hashContent(enc('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('produces a 64-char lowercase hex string with no 0x prefix', () => {
    const h = hashContent(enc('hello'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifies trust-relative: matches-author / mismatch / no-claim', () => {
    const bytes = enc('gm')
    expect(verifyContent(bytes, hashContent(bytes))).toBe('matches-author')
    expect(verifyContent(bytes, hashContent(enc('other')))).toBe('mismatch')
    expect(verifyContent(bytes, undefined)).toBe('no-claim')
  })

  it('flags a malformed claim (0x-prefixed / wrong length) as malformed-claim, not a pass (A9)', () => {
    // A claim that isn't a well-formed bare SHA-256 is an attester bug, distinct
    // from real content/hash divergence ('mismatch') — and never a pass.
    const bytes = enc('gm')
    expect(verifyContent(bytes, `0x${hashContent(bytes)}`)).toBe('malformed-claim')
    expect(verifyContent(bytes, 'deadbeef')).toBe('malformed-claim')
  })
})
