/**
 * Durable-artifact serializers (ADR-0019/R3): versioned envelopes, lossless
 * bigints, fail-closed profile/version rejection, opaque-extension preservation
 * — and the deliberate REJECTION of `toJSON` output (logging ≠ persistence).
 */

import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  MalformedArtifact,
  UnsupportedArtifact,
  parseDataRef,
  parseWriteReceipt,
  serializeDataRef,
  serializeWriteReceipt,
} from '../src/artifacts.js'
import { toJSON } from '../src/json.js'
import type { DataRef, DataUID, WriteReceipt } from '../src/types.js'

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address

const REF: DataRef = {
  __brand: 'DataRef',
  profile: 'efs/v1',
  uid: uid(0xda7a) as DataUID,
  chainId: 11_155_111,
  resolvedBy: addr(0xbeef),
}

const RECEIPT: WriteReceipt = {
  profile: 'efs/v1',
  roles: { author: addr(0xacc), signer: addr(0xacc), payer: addr(0xacc) },
  steps: [
    { id: 'DATA', uid: uid(0x1), done: true },
    { id: 'placementPin', uid: uid(0x2), done: true },
  ],
  signatureCount: 3,
  mechanism: 'sequential',
  status: 'confirmed',
  gasless: false,
}

describe('DataRef round-trip', () => {
  it('serialize → parse restores the ref (brand re-applied, profile checked)', () => {
    const back = parseDataRef(serializeDataRef(REF))
    expect(back.uid).toBe(REF.uid)
    expect(back.chainId).toBe(REF.chainId)
    expect(back.resolvedBy).toBe(REF.resolvedBy)
    expect(back.profile).toBe('efs/v1')
    expect(back.__brand).toBe('DataRef')
  })

  it('preserves opaque extensions verbatim through a round-trip', () => {
    const json = serializeDataRef(REF, { relayHint: 'https://r.example', tries: 3 })
    const back = parseDataRef(json)
    expect(back.ext).toEqual({ relayHint: 'https://r.example', tries: 3 })
    // …and unknown DATA keys survive too (a future field from a newer minor).
    const withExtra = json.replace('"data":{', '"data":{"futureField":"kept",')
    expect((parseDataRef(withExtra) as Record<string, unknown>).futureField).toBe('kept')
  })

  it('REJECTS a foreign profile with UnsupportedArtifact — a v2 logical ID is never read as a v1 EAS UID', () => {
    const v2 = serializeDataRef(REF).replace('"profile":"efs/v1"', '"profile":"efs/v2"')
    const err = (() => {
      try {
        parseDataRef(v2)
        return undefined
      } catch (e) {
        return e as UnsupportedArtifact
      }
    })()
    expect(err).toBeInstanceOf(UnsupportedArtifact)
    expect(err?.foundProfile).toBe('efs/v2')
    expect(err?.code).toBe('UnsupportedArtifact')
  })

  it('REJECTS a newer envelope version', () => {
    const newer = serializeDataRef(REF).replace('"v":1', '"v":2')
    expect(() => parseDataRef(newer)).toThrow(UnsupportedArtifact)
  })

  it('REJECTS malformed input with MalformedArtifact', () => {
    expect(() => parseDataRef('not json')).toThrow(MalformedArtifact)
    expect(() => parseDataRef('{"hello":1}')).toThrow(MalformedArtifact)
    // The wrong artifact kind in a valid envelope.
    expect(() => parseDataRef(serializeWriteReceipt(RECEIPT))).toThrow(MalformedArtifact)
  })
})

describe('WriteReceipt round-trip', () => {
  it('serialize → parse restores steps/roles/profile', () => {
    const back = parseWriteReceipt(serializeWriteReceipt(RECEIPT))
    expect(back.steps).toEqual(RECEIPT.steps)
    expect(back.roles).toEqual(RECEIPT.roles)
    expect(back.signatureCount).toBe(3)
    expect(back.profile).toBe('efs/v1')
  })

  it('revives tagged bigints losslessly (schema-independent — future fields ride free)', () => {
    // No bigint fields exist on the receipt today; smuggle one through ext to
    // pin the tagged encoding end-to-end.
    const big = 2n ** 200n
    const json = serializeWriteReceipt(RECEIPT, { gasUsed: big })
    expect(json).toContain('$efsbigint')
    const back = parseWriteReceipt(json)
    expect(back.ext?.gasUsed).toBe(big)
  })

  it('REJECTS efs.toJSON output — the logging helper is NOT a persistence format', () => {
    const logged = toJSON(RECEIPT)
    expect(() => parseWriteReceipt(logged)).toThrow(MalformedArtifact)
  })
})
