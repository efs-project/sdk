import { type Hex, decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  SchemaEncoder,
  buildAttest,
  buildMultiAttest,
  computeAttestationUID,
  parseSchema,
  verifyAttestationUID,
} from '../src/eas/index.js'

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const
const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as const

describe('parseSchema', () => {
  it('parses a real EFS schema into typed fields', () => {
    expect(parseSchema('string name, bytes32 schemaUID')).toEqual([
      { type: 'string', name: 'name' },
      { type: 'bytes32', name: 'schemaUID' },
    ])
  })

  it('tolerates ragged whitespace and unnamed fields', () => {
    expect(parseSchema('  uint256   amount ,bool')).toEqual([
      { type: 'uint256', name: 'amount' },
      { type: 'bool', name: '' },
    ])
  })

  it('treats the empty schema as zero fields', () => {
    expect(parseSchema('')).toEqual([])
    expect(parseSchema('   ')).toEqual([])
  })

  it('parses a tuple field without splitting on its inner comma', () => {
    // A naive top-level split(',') would wrongly yield 3+ fields here.
    const fields = parseSchema('(uint256 score, string label) result, bool ok')
    expect(fields).toEqual([
      { type: 'tuple', name: 'result' },
      { type: 'bool', name: 'ok' },
    ])
  })
})

describe('SchemaEncoder round-trip', () => {
  it('round-trips a real EFS schema ("string name, bytes32 schemaUID")', () => {
    const enc = new SchemaEncoder('string name, bytes32 schemaUID')
    const uid = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex
    const values = ['efs.root', uid] as const

    const data = enc.encodeData(values)
    // Matches a raw viem encode of the same ABI tuple.
    expect(data).toBe(
      encodeAbiParameters(
        [
          { type: 'string', name: 'name' },
          { type: 'bytes32', name: 'schemaUID' },
        ],
        ['efs.root', uid],
      ),
    )

    const decoded = enc.decodeData(data)
    expect(decoded).toEqual(['efs.root', uid])
  })

  it('handles the empty schema ("" -> 0x, decodes back to [])', () => {
    const enc = new SchemaEncoder('')
    expect(enc.length).toBe(0)
    expect(enc.encodeData([])).toBe('0x')
    expect(enc.decodeData('0x')).toEqual([])
  })

  it('round-trips a schema with a tuple field', () => {
    const enc = new SchemaEncoder('(uint256 score, string label) result, bool ok')
    expect(enc.length).toBe(2)
    const value = [{ score: 7n, label: 'hi' }, true] as const
    const data = enc.encodeData(value)
    expect(enc.decodeData(data)).toEqual([{ score: 7n, label: 'hi' }, true])
  })

  it('rejects arity mismatches', () => {
    const enc = new SchemaEncoder('string name, bytes32 schemaUID')
    expect(() => enc.encodeData(['only-one'])).toThrow(/arity mismatch/)
    expect(() => new SchemaEncoder('').encodeData(['x'])).toThrow(/no values/)
  })

  it('rejects non-empty data for the empty schema', () => {
    expect(() => new SchemaEncoder('').decodeData('0x1234')).toThrow(/empty data/)
  })

  it('round-trips a multi-type schema (uint256, bool, address)', () => {
    const enc = new SchemaEncoder('uint256 score, bool active, address who')
    const values = [42n, true, ZERO_ADDR] as const
    const decoded = enc.decodeData(enc.encodeData(values))
    expect(decoded).toEqual([42n, true, ZERO_ADDR])
  })
})

describe('computeAttestationUID (matches EAS _getUID, EAS.sol:697-712)', () => {
  // Fixed inputs => deterministic UID. We assert against an independent,
  // inline re-implementation of the on-chain packed encoding so the test pins
  // the exact byte layout (schema, recipient, attester, time, expirationTime,
  // revocable, refUID, data, bump).
  const input = {
    schema: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
    recipient: '0x000000000000000000000000000000000000dEaD' as const,
    attester: '0x00000000000000000000000000000000000Ff1CE' as const,
    time: 1_700_000_000n,
    expirationTime: 0n,
    revocable: true,
    refUID: ZERO_UID,
    data: '0xc0ffee' as Hex,
    bump: 0,
  }

  it('is deterministic and matches an inline abi.encodePacked vector', () => {
    const expected = keccak256(
      encodePacked(
        ['bytes32', 'address', 'address', 'uint64', 'uint64', 'bool', 'bytes32', 'bytes', 'uint32'],
        [
          input.schema,
          input.recipient,
          input.attester,
          input.time,
          input.expirationTime,
          input.revocable,
          input.refUID,
          input.data,
          input.bump,
        ],
      ),
    )
    expect(computeAttestationUID(input)).toBe(expected)
  })

  it('is sensitive to the bump (collision counter)', () => {
    const a = computeAttestationUID({ ...input, bump: 0 })
    const b = computeAttestationUID({ ...input, bump: 1 })
    expect(a).not.toBe(b)
  })

  it('produces a 32-byte (66-char) hex UID', () => {
    expect(computeAttestationUID(input)).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('verifyAttestationUID', () => {
  const base = {
    schema: '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex,
    recipient: ZERO_ADDR,
    attester: '0x00000000000000000000000000000000000Ff1CE' as const,
    time: 1_700_000_123n,
    expirationTime: 0n,
    revocationTime: 0n,
    revocable: false,
    refUID: ZERO_UID,
    data: '0x' as Hex,
  }

  it('accepts a self-consistent mined attestation (bump 0)', () => {
    const uid = computeAttestationUID({ ...base, bump: 0 })
    expect(verifyAttestationUID({ ...base, uid })).toBe(true)
  })

  it('rejects a tampered uid', () => {
    expect(
      verifyAttestationUID({
        ...base,
        uid: '0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadba',
      }),
    ).toBe(false)
  })

  it('finds a bumped uid within maxBump', () => {
    const uid = computeAttestationUID({ ...base, bump: 2 })
    expect(verifyAttestationUID({ ...base, uid }, 0)).toBe(false)
    expect(verifyAttestationUID({ ...base, uid }, 3)).toBe(true)
  })
})

describe('SchemaEncoder.decodeData parity with viem', () => {
  it('decodes identically to decodeAbiParameters', () => {
    const params = [
      { type: 'string', name: 'name' },
      { type: 'bytes32', name: 'schemaUID' },
    ] as const
    const uid = '0xabababababababababababababababababababababababababababababababcd' as Hex
    const data = encodeAbiParameters(params, ['x', uid])
    const enc = new SchemaEncoder('string name, bytes32 schemaUID')
    expect(enc.decodeData(data)).toEqual([...decodeAbiParameters(params, data)])
  })
})

describe('attest builders forward resolver value (msg.value)', () => {
  const EAS = '0x0000000000000000000000000000000000000eA5' as const
  const entry = (value?: bigint) => ({
    recipient: ZERO_ADDR,
    expirationTime: 0n,
    revocable: true,
    refUID: ZERO_UID,
    data: '0x' as Hex,
    ...(value === undefined ? {} : { value }),
  })

  it('buildAttest forwards data.value as the tx value (0n by default)', () => {
    expect(buildAttest(EAS, { schema: ZERO_UID, data: entry() }).value).toBe(0n)
    expect(buildAttest(EAS, { schema: ZERO_UID, data: entry(5n) }).value).toBe(5n)
  })

  it('buildMultiAttest sums every entry value across requests', () => {
    const call = buildMultiAttest(EAS, [
      { schema: ZERO_UID, data: [entry(2n), entry(3n)] },
      { schema: ZERO_UID, data: [entry(), entry(4n)] },
    ])
    expect(call.value).toBe(9n)
  })
})

describe('verifyAttestationUID maxBump bounds (reviews r3740495865 + r3740509656)', () => {
  it('rejects NaN/Infinity/negative/fractional/over-budget maxBump before any keccak work — the bound is the PRACTICAL scan budget (1024), not the uint32 wire range', async () => {
    const { verifyAttestationUID } = await import('../src/eas/uid.js')
    const att = {
      uid: `0x${'0'.repeat(64)}`,
      schema: `0x${'0'.repeat(64)}`,
      time: 0n,
      expirationTime: 0n,
      revocationTime: 0n,
      refUID: `0x${'0'.repeat(64)}`,
      recipient: `0x${'0'.repeat(40)}`,
      attester: `0x${'0'.repeat(40)}`,
      revocable: true,
      data: '0x',
    } as never
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 1025, 4_294_967_295]) {
      const err = (() => {
        try {
          verifyAttestationUID(att, bad)
          return undefined
        } catch (e) {
          return e as { code?: string }
        }
      })()
      expect(err?.code, String(bad)).toBe('InvalidArgument')
    }
  })
})
