import { encodeFunctionData, getAbiItem } from 'viem'
import { describe, expect, it } from 'vitest'
import { fileViewAbi } from '../src/chain/abi/fileView.js'
import { EfsError } from '../src/errors.js'
import {
  InvalidDirectoryQuery,
  MAX_ATTESTERS_PER_QUERY,
  MAX_EXCLUDE_TAGS_PER_QUERY,
  reconcileMinWeights,
  shouldUseFilteredQuery,
  validateDirectoryQuery,
} from '../src/reads/directory.js'

const attester = '0x1111111111111111111111111111111111111111' as const
const tagDef = `0x${'ab'.repeat(32)}` as `0x${string}`

describe('fileViewAbi (ADR-0011: vendored EFSFileView view-layer ABI)', () => {
  it('exposes the three directory-page reads', () => {
    for (const name of [
      'getDirectoryPageByAddressList',
      'getDirectoryPageBySchemaAndAddressList',
      'getDirectoryPageFiltered',
    ] as const) {
      expect(getAbiItem({ abi: fileViewAbi, name })).toBeDefined()
    }
  })

  it('viem accepts it as a real ABI (encodes the filtered call)', () => {
    const data = encodeFunctionData({
      abi: fileViewAbi,
      functionName: 'getDirectoryPageFiltered',
      args: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, [attester], [tagDef], [0n], '0x', 50n],
    })
    expect(data.startsWith('0x')).toBe(true)
  })
})

describe('shouldUseFilteredQuery (ADR-0011 §1 routing)', () => {
  it('routes to the unfiltered sibling when no excludes are given', () => {
    expect(shouldUseFilteredQuery([])).toBe(false)
  })

  it('routes to the filtered query when at least one exclude is given', () => {
    expect(shouldUseFilteredQuery([tagDef])).toBe(true)
    expect(shouldUseFilteredQuery([tagDef, tagDef])).toBe(true)
  })
})

describe('reconcileMinWeights (ADR-0042 default / length-mismatch revert guard)', () => {
  it('passes minWeights through verbatim when lengths match', () => {
    const weights = [1n, -2n, 3n]
    const out = reconcileMinWeights([tagDef, tagDef, tagDef], weights)
    expect(out).toEqual([1n, -2n, 3n])
  })

  it('returns a fresh array (does not alias the input)', () => {
    const weights = [5n]
    const out = reconcileMinWeights([tagDef], weights)
    expect(out).toEqual([5n])
    expect(out).not.toBe(weights)
  })

  it('derives an all-zero vector when minWeights is omitted', () => {
    expect(reconcileMinWeights([tagDef, tagDef])).toEqual([0n, 0n])
  })

  it('derives an all-zero vector on length mismatch (too short)', () => {
    expect(reconcileMinWeights([tagDef, tagDef], [1n])).toEqual([0n, 0n])
  })

  it('derives an all-zero vector on length mismatch (too long)', () => {
    expect(reconcileMinWeights([tagDef], [1n, 2n])).toEqual([0n])
  })

  it('returns an empty vector for an empty exclude list', () => {
    expect(reconcileMinWeights([])).toEqual([])
    expect(reconcileMinWeights([], [1n])).toEqual([])
  })
})

describe('validateDirectoryQuery (on-chain cap fail-fast)', () => {
  const valid = {
    attesters: [attester],
    excludeTagDefs: [tagDef],
    maxItems: 50,
  }

  it('passes for a valid query', () => {
    expect(() => validateDirectoryQuery(valid)).not.toThrow()
  })

  it('passes at the exact attester and exclude caps', () => {
    expect(() =>
      validateDirectoryQuery({
        attesters: new Array(MAX_ATTESTERS_PER_QUERY).fill(attester),
        excludeTagDefs: new Array(MAX_EXCLUDE_TAGS_PER_QUERY).fill(tagDef),
        maxItems: 1,
      }),
    ).not.toThrow()
  })

  it('throws a typed EfsError naming the empty-attesters violation', () => {
    let err: unknown
    try {
      validateDirectoryQuery({ ...valid, attesters: [] })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(InvalidDirectoryQuery)
    expect(err).toBeInstanceOf(EfsError)
    expect((err as EfsError).code).toBe('InvalidArgument')
    expect((err as EfsError).message).toMatch(/attester/i)
  })

  it('throws when attesters exceeds the cap, naming the cap', () => {
    let err: unknown
    try {
      validateDirectoryQuery({
        ...valid,
        attesters: new Array(MAX_ATTESTERS_PER_QUERY + 1).fill(attester),
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(InvalidDirectoryQuery)
    expect((err as EfsError).message).toMatch(/MAX_ATTESTERS_PER_QUERY/)
  })

  it('throws when excludeTagDefs exceeds the cap, naming the cap', () => {
    let err: unknown
    try {
      validateDirectoryQuery({
        ...valid,
        excludeTagDefs: new Array(MAX_EXCLUDE_TAGS_PER_QUERY + 1).fill(tagDef),
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(InvalidDirectoryQuery)
    expect((err as EfsError).message).toMatch(/MAX_EXCLUDE_TAGS_PER_QUERY/)
  })

  it('throws when maxItems is zero', () => {
    expect(() => validateDirectoryQuery({ ...valid, maxItems: 0 })).toThrow(InvalidDirectoryQuery)
  })

  it('throws when maxItems is negative', () => {
    expect(() => validateDirectoryQuery({ ...valid, maxItems: -1 })).toThrow(InvalidDirectoryQuery)
  })

  it('accepts a bigint maxItems', () => {
    expect(() => validateDirectoryQuery({ ...valid, maxItems: 10n })).not.toThrow()
    expect(() => validateDirectoryQuery({ ...valid, maxItems: 0n })).toThrow(InvalidDirectoryQuery)
  })
})
