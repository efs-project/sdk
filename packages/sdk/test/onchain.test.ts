/**
 * Unit tests for the on-chain (`web3://` + SSTORE2) storage module
 * (`writes/onchain.ts`) — fully mocked clients, no chain.
 *
 * Covers: the SSTORE2 chunk init-code construction (ported from the contracts
 * reference `simulate-transports.ts` `deploySSTORE2Chunk`), the two-deploy
 * `storeOnchain` flow and its canonical `web3://<manager>` URI, and the typed
 * `MultiChunkUnsupported` / receipt-without-address errors. The URI format is
 * asserted against the shape `EFSRouter._parseContractFromWeb3URI` parses:
 * `web3://0x<40-hex>` (address only — chainId is NOT in the URI).
 */

import { type Address, type Hex, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  MAX_SINGLE_CHUNK_BYTES,
  MultiChunkUnsupported,
  type OnchainStoreContext,
  buildSstore2InitCode,
  storeOnchain,
} from '../src/writes/onchain.js'

const CHUNK_ADDR = '0x000000000000000000000000000000000000c0de' as Address
const MANAGER_ADDR = '0x00000000000000000000000000000000000a1234' as Address

/** A mocked store context recording the chunk init-code + manager args. */
function makeCtx(): {
  ctx: OnchainStoreContext
  calls: { kind: 'chunk' | 'manager'; data?: Hex; args?: readonly Address[] }[]
} {
  const calls: { kind: 'chunk' | 'manager'; data?: Hex; args?: readonly Address[] }[] = []
  const deployAddr = new Map<Hex, Address>()
  let n = 0

  const walletClient = {
    async sendTransaction(args: { data: Hex }) {
      calls.push({ kind: 'chunk', data: args.data })
      const h = `0x${(++n).toString(16).padStart(64, '0')}` as Hex
      deployAddr.set(h, CHUNK_ADDR)
      return h
    },
    async deployContract(args: { args: readonly [readonly Address[]] }) {
      calls.push({ kind: 'manager', args: args.args[0] })
      const h = `0x${(++n).toString(16).padStart(64, '0')}` as Hex
      deployAddr.set(h, MANAGER_ADDR)
      return h
    },
  }
  const publicClient = {
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      return { contractAddress: deployAddr.get(hash) ?? null }
    },
  }
  return { ctx: { walletClient, publicClient } as unknown as OnchainStoreContext, calls }
}

describe('buildSstore2InitCode', () => {
  it('wraps `0x00 || bytes` in the minimal SSTORE2 stub with a 2-byte length', () => {
    const bytes = new Uint8Array([0xaa, 0xbb, 0xcc])
    const code = buildSstore2InitCode(bytes)
    // runtime = 0x00 || bytes → length 4 → 0x0004.
    // stub: 61 0004 80 600c 6000 39 6000 f3 || 00 aabbcc
    expect(code).toBe('0x61000480600c6000396000f300aabbcc')
  })

  it('encodes the runtime length as the content length + 1 (STOP byte)', () => {
    const bytes = new Uint8Array(0x1234) // 4660 content bytes → runtime 4661 = 0x1235
    const code = buildSstore2InitCode(bytes)
    const prefix = '0x611235' + '80600c6000396000f300'
    expect(code.startsWith(prefix)).toBe(true)
    // total chars = prefix (incl. `0x`) + the raw content hex (2 per byte).
    expect(code.length).toBe(prefix.length + 2 * 0x1234)
  })

  it('throws MultiChunkUnsupported above the single-chunk limit', () => {
    const big = new Uint8Array(MAX_SINGLE_CHUNK_BYTES + 1)
    expect(() => buildSstore2InitCode(big)).toThrow(MultiChunkUnsupported)
  })

  it('accepts exactly the single-chunk limit', () => {
    const atCap = new Uint8Array(MAX_SINGLE_CHUNK_BYTES)
    expect(() => buildSstore2InitCode(atCap)).not.toThrow()
  })
})

describe('storeOnchain', () => {
  it('deploys chunk then manager and returns the canonical web3://<manager> URI', async () => {
    const { ctx, calls } = makeCtx()
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { web3Uri, chunkManager, chunkAddress } = await storeOnchain(bytes, ctx)

    expect(calls).toHaveLength(2)
    expect(calls[0].kind).toBe('chunk')
    expect(calls[0].data).toBe(buildSstore2InitCode(bytes))
    expect(calls[1].kind).toBe('manager')
    expect(calls[1].args).toEqual([CHUNK_ADDR])

    expect(chunkAddress).toBe(CHUNK_ADDR)
    expect(chunkManager).toBe(MANAGER_ADDR)
    // EFSRouter._parseContractFromWeb3URI expects web3://0x<40-hex> (address only).
    expect(web3Uri).toBe(`web3://${MANAGER_ADDR}`)
    expect(web3Uri).toMatch(/^web3:\/\/0x[0-9a-fA-F]{40}$/)
  })

  it('round-trips the content into the chunk runtime (after the STOP byte)', async () => {
    const { ctx, calls } = makeCtx()
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    await storeOnchain(bytes, ctx)
    // The chunk init code ends with `00` (STOP) followed by the raw content hex.
    expect(calls[0].data?.endsWith(`00${toHex(bytes).slice(2)}`)).toBe(true)
  })

  it('throws when a deploy receipt carries no contractAddress', async () => {
    const { ctx } = makeCtx()
    // Override the public client to drop the contract address (simulates a non-deploy
    // receipt / wrong tx).
    const broken = {
      ...ctx,
      publicClient: {
        async waitForTransactionReceipt() {
          return { contractAddress: null }
        },
      },
    } as unknown as OnchainStoreContext
    await expect(storeOnchain(new Uint8Array([1]), broken)).rejects.toThrow(/no contract address/)
  })
})
