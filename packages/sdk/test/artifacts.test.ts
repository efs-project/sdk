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

describe('adversarial-review regressions', () => {
  it('bigint tag is INJECTIVE: user ext/data shaped like the tag round-trips verbatim', async () => {
    const { parseWriteReceipt, serializeWriteReceipt } = await import('../src/artifacts.js')
    const receipt = {
      profile: 'efs/v1',
      path: '/x',
      resolvedBy: '0x0000000000000000000000000000000000000001',
      steps: [],
      signatureCount: 1,
      mechanism: 'direct',
    } as never
    const ext = {
      literal: { $efsbigint: '5' }, // looks exactly like the tag
      escapedShape: { $efsbigint$: 'x' }, // looks like the escaped form
      real: 7n, // an actual bigint alongside
    }
    const out = parseWriteReceipt(serializeWriteReceipt(receipt, ext))
    expect(out.ext?.literal).toEqual({ $efsbigint: '5' }) // NOT revived as 5n
    expect(out.ext?.escapedShape).toEqual({ $efsbigint$: 'x' })
    expect(out.ext?.real).toBe(7n)
  })

  it('parseDataRef: a crafted payload cannot clobber __brand (or any load-bearing field)', async () => {
    const { parseDataRef, serializeDataRef } = await import('../src/artifacts.js')
    const ref = {
      __brand: 'DataRef',
      profile: 'efs/v1',
      uid: `0x${'11'.repeat(32)}`,
      chainId: 1,
      resolvedBy: '0x0000000000000000000000000000000000000002',
    } as never
    const json = serializeDataRef(ref)
    // Inject a hostile __brand into the payload.
    const tampered = json.replace('"data":{', '"data":{"__brand":"EvilRef",')
    const out = parseDataRef(tampered)
    expect(out.__brand).toBe('DataRef')
  })
})

describe('strict ID validation at the parse boundary (review r3740509657)', () => {
  it('parseDataRef rejects malformed uid/address/chainId as MalformedArtifact', async () => {
    const { parseDataRef, serializeDataRef, MalformedArtifact } = await import(
      '../src/artifacts.js'
    )
    const good = {
      __brand: 'DataRef',
      profile: 'efs/v1',
      uid: `0x${'11'.repeat(32)}`,
      chainId: 1,
      resolvedBy: `0x${'22'.repeat(20)}`,
    } as never
    const json = serializeDataRef(good)
    const cases: [string, string][] = [
      [`"uid":"0x${'11'.repeat(32)}"`, '"uid":"x"'],
      [`"resolvedBy":"0x${'22'.repeat(20)}"`, '"resolvedBy":"0xnotanaddress"'],
      ['"chainId":1', '"chainId":1.5'],
      ['"chainId":1', '"chainId":-5'],
    ]
    for (const [from, to] of cases) {
      const tampered = json.replace(from, to)
      expect(tampered, to).not.toBe(json)
      const err = await Promise.resolve()
        .then(() => parseDataRef(tampered))
        .then(() => undefined)
        .catch((e) => e)
      expect(err, to).toBeInstanceOf(MalformedArtifact)
    }
    expect(parseDataRef(json).uid).toBe(good.uid) // the untampered ref still parses
  })

  it('parseWriteReceipt rejects NaN signatureCount and non-bytes32 step uids', async () => {
    const { parseWriteReceipt, serializeWriteReceipt, MalformedArtifact } = await import(
      '../src/artifacts.js'
    )
    const receipt = {
      profile: 'efs/v1',
      steps: [{ id: 'DATA', uid: `0x${'33'.repeat(32)}`, done: true }],
      signatureCount: 1,
      mechanism: 'direct',
    } as never
    const json = serializeWriteReceipt(receipt)
    for (const [from, to] of [
      ['"signatureCount":1', '"signatureCount":null'],
      ['"signatureCount":1', '"signatureCount":1.5'],
      [`"uid":"0x${'33'.repeat(32)}"`, '"uid":"0xdead"'],
    ] as [string, string][]) {
      const tampered = json.replace(from, to)
      expect(tampered, to).not.toBe(json)
      const err = await Promise.resolve()
        .then(() => parseWriteReceipt(tampered))
        .then(() => undefined)
        .catch((e) => e)
      expect(err, to).toBeInstanceOf(MalformedArtifact)
    }
  })
})
