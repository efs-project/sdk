/**
 * `ReadSource` seam (ADR-0014) + reserved injection seams (Fork 2). These cover the additive
 * scaffolding: the live viem adapter (chain-as-data + capabilities), the reserved
 * snapshot/indexer stubs (honest capabilities, `NotImplemented` reads), and the reserved
 * client-config slots (`fetch`/`verifier`) that fail loudly rather than silently no-op.
 */

import { type Address, type PublicClient, createPublicClient, custom } from 'viem'
import { sepolia } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import {
  createEfsClient,
  indexerReadSource,
  snapshotReadSource,
  viemReadSource,
} from '../src/index.js'
import { createMockProvider } from './helpers/mock-eip1193.js'

const ADDR = '0x000000000000000000000000000000000000c0de' as Address

/** A minimal viem-PublicClient-shaped mock for the adapter (only the methods it forwards). */
function mockPublic(opts: { chainId?: number } = {}): PublicClient {
  return {
    ...(opts.chainId !== undefined ? { chain: { id: opts.chainId } } : {}),
    readContract: async () => '0xresult',
    getCode: async () => '0x1234',
    getEnsAddress: async () => ADDR,
    getChainId: async () => opts.chainId ?? 1,
  } as unknown as PublicClient
}

describe('viemReadSource (live adapter)', () => {
  it('binds chainId from the client chain and reports live capabilities', async () => {
    const src = viemReadSource(mockPublic({ chainId: 11_155_111 }))
    expect(src.chainId).toBe(11_155_111)
    expect(src.capabilities).toMatchObject({
      kind: 'live',
      state: 'head', // follows its backend's head — the endpoint is the residual trust
      supportsGetCode: true,
      supportsEns: true,
      readContract: 'arbitrary',
      supportsRangeQueries: true,
    })
    expect('authoritative' in src.capabilities).toBe(false) // the subjective boolean is GONE
    expect(await src.readContract({ address: ADDR, abi: [], functionName: 'x' })).toBe('0xresult')
  })

  it('accepts chainId as DATA for a chainless client (the offline/edge case)', () => {
    const src = viemReadSource(mockPublic(), { chainId: 26_001_993 })
    expect(src.chainId).toBe(26_001_993) // supplied, not sniffed from a bound chain
  })

  it('throws InvalidArgument when chainless and no chainId is supplied', () => {
    expect(() => viemReadSource(mockPublic())).toThrow(/no bound .chain./)
  })
})

describe('snapshotReadSource (offline stub)', () => {
  it('is pinned and carries the capture basis (block/asOf)', () => {
    const src = snapshotReadSource({ chainId: 1, block: 100n, asOf: 1_700_000_000, records: {} })
    expect(src.chainId).toBe(1)
    expect(src.capabilities.kind).toBe('snapshot')
    expect(src.capabilities.state).toBe('pinned') // cannot confirm existence/revocation offline
    expect(src.capabilities.pinnedBasis).toEqual({
      chainId: 1,
      blockNumber: 100n,
      asOf: 1_700_000_000,
    })
  })

  it('capability metadata is CALLABLE behavior, not stored contents: getCode/ENS stay off until the lookup slice lands', () => {
    // Even a snapshot that CAPTURED code + ENS advertises neither — a present
    // getCode answering `undefined` would assert "no bytecode here", a WRONG
    // answer the web3:// reader would trust. Absent method = honest signal.
    const src = snapshotReadSource({
      chainId: 1,
      block: 1n,
      asOf: 1,
      records: {},
      code: { [ADDR]: '0x6000' },
      ens: { 'a.eth': ADDR },
    })
    expect(src.capabilities.supportsGetCode).toBe(false)
    expect(src.capabilities.supportsEns).toBe(false)
    expect('getCode' in src).toBe(false)
    expect('getEnsAddress' in src).toBe(false)
  })

  it('throws NotImplemented on read (the lookup is a later slice)', async () => {
    const src = snapshotReadSource({ chainId: 1, block: 1n, asOf: 1, records: {} })
    const err = await src
      .readContract({ address: ADDR, abi: [], functionName: 'x' })
      .catch((e) => e)
    expect((err as { code?: string }).code).toBe('NotImplemented')
  })
})

describe('indexerReadSource (stub)', () => {
  it('is lagging, range-capable, and has no EVM (getCode)', async () => {
    const src = indexerReadSource({ chainId: 1, url: 'https://idx.example' })
    expect(src.capabilities).toMatchObject({
      kind: 'indexer',
      state: 'lagging', // tails a trailing head — freshness is as-of, never current
      supportsGetCode: false,
      supportsRangeQueries: true,
    })
    const err = await src
      .readContract({ address: ADDR, abi: [], functionName: 'x' })
      .catch((e) => e)
    expect((err as { code?: string }).code).toBe('NotImplemented')
  })
})

describe('reserved client-config seams (Fork 2)', () => {
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: custom(createMockProvider({ chainId: 11_155_111 })),
  })

  it('throws NotImplemented for a client-level `fetch` (reserved, not a silent no-op)', () => {
    expect(() => createEfsClient({ publicClient, fetch: globalThis.fetch })).toThrow(
      /NotImplemented|reserved/i,
    )
  })

  it('throws NotImplemented for a `verifier` (reserved)', () => {
    expect(() => createEfsClient({ publicClient, verifier: { verify: () => true } })).toThrow(
      /NotImplemented|reserved/i,
    )
  })
})
