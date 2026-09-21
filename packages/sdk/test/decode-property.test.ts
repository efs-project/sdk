/**
 * `decodePropertyValue` — a stored EMPTY property value (`''`) must round-trip, not be
 * coerced to `undefined`. Absence is the missing property/binding UID upstream, never an
 * empty value (Codex review). Only truly absent data (`0x`/empty) decodes to `undefined`.
 */
import { encodeAbiParameters } from 'viem'
import { describe, expect, it } from 'vitest'
import { decodePropertyValue } from '../src/reads/context.js'

const enc = (s: string) => encodeAbiParameters([{ type: 'string' }], [s])

describe('decodePropertyValue', () => {
  it('returns a stored empty string ("") — not undefined', () => {
    expect(decodePropertyValue(enc(''))).toBe('')
  })

  it('returns a non-empty stored value verbatim', () => {
    expect(decodePropertyValue(enc('text/markdown'))).toBe('text/markdown')
  })

  it('returns undefined only for ABSENT data (0x / too short)', () => {
    expect(decodePropertyValue('0x')).toBeUndefined()
    expect(decodePropertyValue('0x00')).toBeUndefined()
  })
})
