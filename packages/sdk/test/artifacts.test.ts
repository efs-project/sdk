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
    const A = `0x${'01'.repeat(20)}`
    const receipt = {
      profile: 'efs/v1',
      path: '/x',
      resolvedBy: A,
      roles: { author: A, signer: A, payer: A },
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
    const B = `0x${'02'.repeat(20)}`
    const receipt = {
      profile: 'efs/v1',
      roles: { author: B, signer: B, payer: B },
      steps: [{ id: 'DATA', uid: `0x${'33'.repeat(32)}`, done: true }],
      signatureCount: 1,
      mechanism: 'direct',
    } as never
    const json = serializeWriteReceipt(receipt)
    for (const [from, to] of [
      ['"signatureCount":1', '"signatureCount":null'],
      ['"signatureCount":1', '"signatureCount":1.5'],
      [`"uid":"0x${'33'.repeat(32)}"`, '"uid":"0xdead"'],
      ['"mechanism":"direct"', '"mechanism":7'],
      [`"author":"${B}"`, '"author":"0xnope"'],
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

describe('envelope version discipline (review r3740549059)', () => {
  it('rejects 0 / negative / fractional versions as MalformedArtifact; newer stays UnsupportedArtifact', async () => {
    const { parseDataRef, serializeDataRef, MalformedArtifact, UnsupportedArtifact } = await import(
      '../src/artifacts.js'
    )
    const A20 = `0x${'04'.repeat(20)}`
    const ref = {
      __brand: 'DataRef',
      profile: 'efs/v1',
      uid: `0x${'44'.repeat(32)}`,
      chainId: 1,
      resolvedBy: A20,
    } as never
    const json = serializeDataRef(ref)
    for (const v of ['0', '-1', '0.5']) {
      const tampered = json.replace('"v":1', `"v":${v}`)
      expect(tampered).not.toBe(json)
      const err = await Promise.resolve()
        .then(() => parseDataRef(tampered))
        .then(() => undefined)
        .catch((e) => e)
      expect(err, v).toBeInstanceOf(MalformedArtifact)
    }
    const newer = json.replace('"v":1', '"v":2')
    await expect(Promise.resolve().then(() => parseDataRef(newer))).rejects.toBeInstanceOf(
      UnsupportedArtifact,
    )
  })
})

describe('optional typed receipt fields validate when present (review r3740563983)', () => {
  it('malformed data/contentHash/reason are MalformedArtifact; unknown keys still pass', async () => {
    const { parseWriteReceipt, serializeWriteReceipt, MalformedArtifact } = await import(
      '../src/artifacts.js'
    )
    const C = `0x${'05'.repeat(20)}`
    const receipt = {
      profile: 'efs/v1',
      roles: { author: C, signer: C, payer: C },
      steps: [],
      signatureCount: 1,
      mechanism: 'direct',
      contentHash: `f1220${'ab'.repeat(32)}`,
      data: {
        __brand: 'DataRef',
        profile: 'efs/v1',
        uid: `0x${'55'.repeat(32)}`,
        chainId: 1,
        resolvedBy: C,
      },
      reason: { selected: 'direct', why: 'no-in-account-adapter' },
      someUnknownExtension: { anything: true }, // must survive untouched
    } as never
    const json = serializeWriteReceipt(receipt)
    expect(
      (parseWriteReceipt(json) as { someUnknownExtension?: unknown }).someUnknownExtension,
    ).toEqual({ anything: true })
    for (const [from, to] of [
      [`"uid":"0x${'55'.repeat(32)}"`, '"uid":"x"'], // fake DataRef
      [`"contentHash":"f1220${'ab'.repeat(32)}"`, '"contentHash":"deadbeef"'], // non-canonical
      ['"reason":{"selected":"direct","why":"no-in-account-adapter"}', '"reason":{"selected":7}'],
      ['"gasless":', '"gasless":'], // no-op guard: skip if absent
    ] as [string, string][]) {
      if (!json.includes(from)) continue
      const tampered = json.replace(from, to)
      if (tampered === json) continue
      const err = await Promise.resolve()
        .then(() => parseWriteReceipt(tampered))
        .then(() => undefined)
        .catch((e) => e)
      expect(err, to).toBeInstanceOf(MalformedArtifact)
    }
  })
})

describe('nested receipt data brand (review r3740877070)', () => {
  it('a FORGED nested __brand is rebuilt to DataRef (never spread through)', () => {
    const raw = JSON.parse(serializeWriteReceipt({ ...RECEIPT, data: REF })) as {
      data: { data: Record<string, unknown> }
    }
    raw.data.data.__brand = 'Forged'
    const out = parseWriteReceipt(JSON.stringify(raw))
    expect(out.data?.__brand).toBe('DataRef')
    expect(out.data?.uid).toBe(REF.uid)
    expect(out.data?.profile).toBe('efs/v1')
  })

  it('a MISSING nested __brand is added by the parser', () => {
    const raw = JSON.parse(serializeWriteReceipt({ ...RECEIPT, data: REF })) as {
      data: { data: Record<string, unknown> }
    }
    raw.data.data.__brand = undefined // JSON.stringify drops undefined-valued keys → absent
    const out = parseWriteReceipt(JSON.stringify(raw))
    expect(out.data?.__brand).toBe('DataRef')
    expect(out.data?.chainId).toBe(REF.chainId)
  })
})

describe('envelope ext round-trip (review r3740769006)', () => {
  it('serializeDataRef(parseDataRef(json)) keeps the bag at the ENVELOPE, never in the payload', () => {
    const first = serializeDataRef(REF, { relayHint: 'https://r.example' })
    const back = parseDataRef(first)
    const second = serializeDataRef(back) // no explicit ext — the parsed bag rides
    const raw = JSON.parse(second) as { data: Record<string, unknown>; ext?: unknown }
    expect(raw.ext).toEqual({ relayHint: 'https://r.example' })
    expect('ext' in raw.data).toBe(false) // never demoted into the payload
    expect(parseDataRef(second).ext).toEqual({ relayHint: 'https://r.example' })
  })

  it('an explicit ext argument overrides the parsed bag', () => {
    const back = parseDataRef(serializeDataRef(REF, { a: 1 }))
    const out = parseDataRef(serializeDataRef(back, { b: 2 }))
    expect(out.ext).toEqual({ b: 2 })
  })

  it('serializeWriteReceipt(parseWriteReceipt(json)) keeps the bag too', () => {
    const back = parseWriteReceipt(serializeWriteReceipt(RECEIPT, { resume: true }))
    const second = serializeWriteReceipt(back)
    const raw = JSON.parse(second) as { data: Record<string, unknown>; ext?: unknown }
    expect(raw.ext).toEqual({ resume: true })
    expect('ext' in raw.data).toBe(false)
    expect(parseWriteReceipt(second).ext).toEqual({ resume: true })
  })

  it("a payload-level 'ext' key is rejected (reserved to the envelope)", () => {
    // A crafted payload `ext` would surface on the parsed object exactly like
    // the caller's own envelope bag — MalformedArtifact at the boundary.
    const crafted = serializeDataRef(REF).replace('"data":{', '"data":{"ext":{"evil":1},')
    expect(() => parseDataRef(crafted)).toThrowError(/reserved top-level key 'ext'/)
    const craftedReceipt = serializeWriteReceipt(RECEIPT).replace(
      '"data":{',
      '"data":{"ext":{"evil":1},',
    )
    expect(() => parseWriteReceipt(craftedReceipt)).toThrowError(/reserved top-level key 'ext'/)
  })
})

describe('reason discriminant + ext shape (reviews r3740620191 / r3740620193)', () => {
  it('rejects an unknown reason.why literal and a selected↔mechanism mismatch', async () => {
    const { parseWriteReceipt, serializeWriteReceipt, MalformedArtifact } = await import(
      '../src/artifacts.js'
    )
    const D = `0x${'06'.repeat(20)}`
    const receipt = {
      profile: 'efs/v1',
      roles: { author: D, signer: D, payer: D },
      steps: [],
      signatureCount: 1,
      mechanism: 'sequential',
      reason: { selected: 'sequential', why: 'dependent-dag-needs-sequential' },
    } as never
    const json = serializeWriteReceipt(receipt)
    expect(parseWriteReceipt(json).reason?.why).toBe('dependent-dag-needs-sequential')
    for (const [from, to] of [
      ['"why":"dependent-dag-needs-sequential"', '"why":"bogus"'],
      ['"selected":"sequential"', '"selected":"erc4337"'], // inconsistent with mechanism
    ] as [string, string][]) {
      const tampered = json.replace(from, to)
      expect(tampered).not.toBe(json)
      const err = await Promise.resolve()
        .then(() => parseWriteReceipt(tampered))
        .then(() => undefined)
        .catch((e) => e)
      expect(err, to).toBeInstanceOf(MalformedArtifact)
    }
  })

  it('rejects ext that is null or an array (the signature promises a record)', async () => {
    const { parseDataRef, serializeDataRef, MalformedArtifact } = await import(
      '../src/artifacts.js'
    )
    const ref = {
      __brand: 'DataRef',
      profile: 'efs/v1',
      uid: `0x${'66'.repeat(32)}`,
      chainId: 1,
      resolvedBy: `0x${'07'.repeat(20)}`,
    } as never
    const json = serializeDataRef(ref, { ok: true })
    expect(parseDataRef(json).ext).toEqual({ ok: true })
    for (const bad of ['null', '[1,2]', '"str"', '7']) {
      const tampered = json.replace('"ext":{"ok":true}', `"ext":${bad}`)
      expect(tampered).not.toBe(json)
      const err = await Promise.resolve()
        .then(() => parseDataRef(tampered))
        .then(() => undefined)
        .catch((e) => e)
      expect(err, bad).toBeInstanceOf(MalformedArtifact)
    }
  })
})
