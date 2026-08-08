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
import { EfsError, RpcError, UserRejected } from '../src/errors.js'
import {
  MAX_SINGLE_CHUNK_BYTES,
  MultiChunkUnsupported,
  OnchainDeployUnconfirmed,
  type OnchainStoreContext,
  OnchainStoreIncomplete,
  buildSstore2InitCode,
  storeOnchain,
} from '../src/writes/onchain.js'

const CHUNK_ADDR = '0x000000000000000000000000000000000000c0de' as Address
const MANAGER_ADDR = '0x00000000000000000000000000000000000a1234' as Address

/** A mocked store context recording the chunk init-code + manager args. */
function makeCtx(): {
  ctx: OnchainStoreContext
  calls: {
    kind: 'chunk' | 'manager'
    data?: Hex
    args?: readonly Address[]
    contentType?: string
  }[]
} {
  const calls: {
    kind: 'chunk' | 'manager'
    data?: Hex
    args?: readonly Address[]
    contentType?: string
  }[] = []
  const deployAddr = new Map<Hex, Address>()
  let n = 0

  const walletClient = {
    async sendTransaction(args: { data: Hex }) {
      calls.push({ kind: 'chunk', data: args.data })
      const h = `0x${(++n).toString(16).padStart(64, '0')}` as Hex
      deployAddr.set(h, CHUNK_ADDR)
      return h
    },
    async deployContract(args: { args: readonly [readonly Address[], string] }) {
      calls.push({ kind: 'manager', args: args.args[0], contentType: args.args[1] })
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
    const { web3Uri, chunkManager, chunkAddress, txHashes } = await storeOnchain(bytes, ctx)

    expect(calls).toHaveLength(2)
    expect(calls[0].kind).toBe('chunk')
    expect(calls[0].data).toBe(buildSstore2InitCode(bytes))
    expect(calls[1].kind).toBe('manager')
    expect(calls[1].args).toEqual([CHUNK_ADDR])

    // Both wallet txs (chunk + manager) are reported so the caller can count them as
    // wallet confirmations in the write receipt's signatureCount.
    expect(txHashes).toHaveLength(2)

    expect(chunkAddress).toBe(CHUNK_ADDR)
    expect(chunkManager).toBe(MANAGER_ADDR)
    // EFSRouter._parseContractFromWeb3URI expects web3://0x<40-hex> (address only).
    expect(web3Uri).toBe(`web3://${MANAGER_ADDR}`)
    expect(web3Uri).toMatch(/^web3:\/\/0x[0-9a-fA-F]{40}$/)
  })

  it('passes the ERC-5219 contentType to the store constructor (2-arg)', async () => {
    const { ctx, calls } = makeCtx()
    await storeOnchain(new Uint8Array([1, 2, 3]), { ...ctx, contentType: 'text/markdown' })
    const manager = calls.find((c) => c.kind === 'manager')
    expect(manager?.args).toEqual([CHUNK_ADDR])
    expect(manager?.contentType).toBe('text/markdown') // threaded into EFSBytesStore(chunks, contentType_)
  })

  it('defaults the store contentType to empty (⇒ application/octet-stream) when omitted', async () => {
    const { ctx, calls } = makeCtx()
    await storeOnchain(new Uint8Array([1, 2, 3]), ctx) // no contentType in ctx
    expect(calls.find((c) => c.kind === 'manager')?.contentType).toBe('')
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

  it('classifies a wallet rejection on the chunk deploy into UserRejected', async () => {
    const { ctx } = makeCtx()
    // viem/provider surfaces EIP-1193 4001 for a user rejection — must become the SDK's
    // typed UserRejected, not a raw provider error, on the default quickstart write path.
    const rejecting = {
      ...ctx,
      walletClient: {
        ...ctx.walletClient,
        async sendTransaction() {
          throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
        },
      },
    } as unknown as OnchainStoreContext
    await expect(storeOnchain(new Uint8Array([1, 2, 3]), rejecting)).rejects.toBeInstanceOf(
      UserRejected,
    )
  })

  it('a wait failure after broadcast preserves the in-flight txHash (OnchainDeployUnconfirmed, review r3740521403)', async () => {
    // The deploy tx IS broadcast when the wait dies — reducing that to a bare
    // classified RpcError (the old contract) lost the hash and invited a blind
    // retry paying for a DUPLICATE deploy. The unknown-outcome state is now
    // structured: OnchainDeployUnconfirmed carries the hash; the classified
    // RPC failure rides as `cause`.
    const { ctx } = makeCtx()
    const flaky = {
      ...ctx,
      publicClient: {
        async waitForTransactionReceipt() {
          throw Object.assign(new Error('JSON-RPC internal error'), { code: -32000 })
        },
      },
    } as unknown as OnchainStoreContext
    const err = await storeOnchain(new Uint8Array([1, 2, 3]), flaky).catch((e) => e)
    expect(err).toBeInstanceOf(OnchainDeployUnconfirmed)
    const u = err as OnchainDeployUnconfirmed
    expect(u.txHash).toMatch(/^0x/)
    expect(u.code).toBe('PartialBatchFailure')
    expect((u.cause as { code?: string })?.code).toBe('RpcError') // classified underneath
  })

  it('does NOT re-wrap a typed MultiChunkUnsupported through the classifier', async () => {
    // buildSstore2InitCode throws before any wallet call; classifyError is idempotent,
    // so the typed error must survive (not collapse into a generic EfsError).
    const { ctx } = makeCtx()
    const big = new Uint8Array(MAX_SINGLE_CHUNK_BYTES + 1)
    await expect(storeOnchain(big, ctx)).rejects.toBeInstanceOf(MultiChunkUnsupported)
  })

  it('aborts between the chunk and manager deploys — never sends the manager tx', async () => {
    const { ctx, calls } = makeCtx()
    const controller = new AbortController()
    const origSend = ctx.walletClient.sendTransaction.bind(ctx.walletClient)
    // Abort right after the chunk deploy returns — the between-deploys signal check
    // must stop before the (irreversible) manager deploy.
    ;(ctx.walletClient as { sendTransaction: unknown }).sendTransaction = async (a: unknown) => {
      const h = await (origSend as (x: unknown) => Promise<Hex>)(a)
      controller.abort()
      return h
    }
    const signalCtx = { ...ctx, signal: controller.signal } as unknown as OnchainStoreContext
    const err = await storeOnchain(new Uint8Array([1, 2, 3]), signalCtx).catch((e) => e)
    // The chunk LANDED before the abort — the failure must carry the landed
    // chunk state (r3740549054): a raw AbortError would invite a blind retry
    // paying for a duplicate chunk. Same post-landed-wraps rule as the layered
    // submitter; the AbortError rides as `cause`.
    expect(err).toBeInstanceOf(OnchainStoreIncomplete)
    const p = err as OnchainStoreIncomplete
    expect(p.chunkAddress).toMatch(/^0x/)
    expect(p.chunkTx).toMatch(/^0x/)
    expect((p.cause as Error).name).toBe('AbortError')
    expect(calls.filter((c) => c.kind === 'chunk')).toHaveLength(1) // chunk did deploy
    expect(calls.filter((c) => c.kind === 'manager')).toHaveLength(0) // manager never sent
  })

  it('re-checks the chain before each receipt wait — a switch after the chunk send stops at the chunk wait', async () => {
    const { ctx, calls } = makeCtx()
    let checks = 0
    // assertChain runs before BOTH the deploy AND the receipt wait, per deploy. The chunk
    // deploy guard (1) passes and the chunk broadcasts; the provider then drifts, so the
    // chunk's PRE-WAIT guard (2) fails closed — the wait never queries the wrong chain (which
    // would falsely report "no contract address"), and the manager step is never reached.
    const assertChain = async () => {
      checks += 1
      if (checks >= 2) throw new EfsError('wrong chain', { code: 'WrongChain' })
    }
    const guarded = { ...ctx, assertChain } as unknown as OnchainStoreContext
    const err = await storeOnchain(new Uint8Array([1, 2, 3]), guarded).catch((e) => e)
    // Post-broadcast the drift is an UNKNOWN outcome, not a definite failure —
    // it surfaces as OnchainDeployUnconfirmed carrying the in-flight hash, with
    // the WrongChain visible as `cause` (pre-send drift still throws raw).
    expect(err).toBeInstanceOf(OnchainDeployUnconfirmed)
    expect(((err as OnchainDeployUnconfirmed).cause as { code?: string })?.code).toBe('WrongChain')
    expect(checks).toBe(2) // before the chunk deploy (passed), before the chunk wait (threw)
    expect(calls.filter((c) => c.kind === 'chunk')).toHaveLength(1) // chunk did deploy
    expect(calls.filter((c) => c.kind === 'manager')).toHaveLength(0) // manager never sent
  })

  it('re-asserts between deploys — a switch before the manager deploy stops it', async () => {
    const { ctx, calls } = makeCtx()
    let checks = 0
    // The chunk deploy + wait both pass (checks 1, 2); the provider then drifts, so the
    // manager's PRE-DEPLOY guard (3) fails closed — the manager never broadcasts to the new
    // chain while the chunk's receipt was awaited on the deployment chain.
    const assertChain = async () => {
      checks += 1
      if (checks >= 3) throw new EfsError('wrong chain', { code: 'WrongChain' })
    }
    const guarded = { ...ctx, assertChain } as unknown as OnchainStoreContext
    const err = await storeOnchain(new Uint8Array([1, 2, 3]), guarded).catch((e) => e)
    // Post-landed-chunk failures carry the landed state; the drift rides as cause.
    expect(err).toBeInstanceOf(OnchainStoreIncomplete)
    expect(((err as OnchainStoreIncomplete).cause as { code?: string })?.code).toBe('WrongChain')
    expect(checks).toBe(3) // chunk deploy + chunk wait passed; manager deploy guard threw
    expect(calls.filter((c) => c.kind === 'chunk')).toHaveLength(1) // chunk did deploy
    expect(calls.filter((c) => c.kind === 'manager')).toHaveLength(0) // manager never sent
  })
})

describe('OnchainStoreIncomplete (review r3740549054)', () => {
  it('a wallet rejection on the MANAGER deploy carries the landed chunk state', async () => {
    const { ctx, calls } = makeCtx()
    const origSend = ctx.walletClient.deployContract?.bind(ctx.walletClient)
    ;(ctx.walletClient as { deployContract: unknown }).deployContract = async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    }
    void origSend
    const err = await storeOnchain(new Uint8Array([1, 2, 3]), ctx).catch((e) => e)
    expect(err).toBeInstanceOf(OnchainStoreIncomplete)
    const p = err as OnchainStoreIncomplete
    expect(p.chunkAddress).toMatch(/^0x/)
    expect((p.cause as { code?: string })?.code).toBe('UserRejected')
    expect(calls.filter((c) => c.kind === 'chunk')).toHaveLength(1)
  })
})
