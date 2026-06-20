import { describe, expect, it } from 'vitest'
import type { FileInfo, ListConfig, WriteReceipt } from '../src/index.js'
import { jsonReplacer, toJSON } from '../src/index.js'

describe('bigint-safe JSON serialization (review P3 DX)', () => {
  it('bare JSON.stringify throws on a bigint (the surprise this helper removes)', () => {
    expect(() => JSON.stringify({ size: 1024n })).toThrow(TypeError)
  })

  it('toJSON renders a bigint as a decimal string', () => {
    expect(toJSON({ size: 1024n })).toBe('{"size":"1024"}')
    // No `n` suffix, base-10, and large values are exact (beyond Number.MAX_SAFE_INTEGER).
    expect(toJSON({ gas: 9007199254740993n })).toBe('{"gas":"9007199254740993"}')
  })

  it('serializes a WriteReceipt with a bigint-free body unchanged + nested bigints stringified', () => {
    const receipt = {
      contentHash: '0xabc' as WriteReceipt['contentHash'],
      steps: [{ id: 'data:/hello.txt', uid: '0x01', done: true }],
      signatureCount: 1,
      mechanism: 'sequential',
      gasless: false,
    } as unknown as WriteReceipt
    // Round-trips structurally (no bigints in this receipt → no surprise either way).
    expect(JSON.parse(toJSON(receipt))).toEqual({
      contentHash: '0xabc',
      steps: [{ id: 'data:/hello.txt', uid: '0x01', done: true }],
      signatureCount: 1,
      mechanism: 'sequential',
      gasless: false,
    })
  })

  it('serializes a ListConfig (maxEntries is a bigint) without throwing', () => {
    const config = {
      listUID: '0xlist',
      exists: true,
      curator: '0x0000000000000000000000000000000000000001',
      allowsDuplicates: false,
      appendOnly: true,
      targetType: 'addr',
      targetSchema: '0x00',
      maxEntries: 100n,
    } as unknown as ListConfig
    const parsed = JSON.parse(toJSON(config))
    expect(parsed.maxEntries).toBe('100') // bigint → decimal string
    expect(parsed.targetType).toBe('addr')
  })

  it('serializes a FileInfo (size is a bigint) without throwing', () => {
    const info = {
      exists: true,
      contentType: 'text/plain',
      size: 2048n,
      resolvedBy: '0x0000000000000000000000000000000000000002',
      verified: 'matches-author',
      sourceUIDs: {},
    } as unknown as FileInfo
    // The whole point: bare JSON.stringify(info) throws; toJSON(info) does not.
    expect(() => JSON.stringify(info)).toThrow(TypeError)
    const parsed = JSON.parse(toJSON(info))
    expect(parsed.size).toBe('2048')
    expect(parsed.contentType).toBe('text/plain')
  })

  it('jsonReplacer composes with JSON.stringify directly + honors the `space` arg via toJSON', () => {
    expect(JSON.stringify({ a: 1n, b: 'x' }, jsonReplacer)).toBe('{"a":"1","b":"x"}')
    expect(toJSON({ a: 1n }, 2)).toBe('{\n  "a": "1"\n}')
  })

  it('leaves non-bigint values (including 0n at top level) correctly handled', () => {
    expect(toJSON(0n)).toBe('"0"')
    expect(toJSON({ n: null, s: 'hi', x: 2, b: true, arr: [1n, 2n] })).toBe(
      '{"n":null,"s":"hi","x":2,"b":true,"arr":["1","2"]}',
    )
  })

  it('round-trip caveat: bigints come back as strings, not bigints', () => {
    const back = JSON.parse(toJSON({ size: 42n })) as { size: unknown }
    expect(typeof back.size).toBe('string')
    expect(BigInt(back.size as string)).toBe(42n) // the consumer re-BigInts known-numeric fields
  })
})
