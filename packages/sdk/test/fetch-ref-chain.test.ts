/**
 * `fetchRef` cross-chain guard: a {@link DataRef} carries its origin chain, but EAS
 * UIDs and `web3://` mirrors are NOT chain-qualified — using a ref from chain A against
 * a client connected to chain B would silently read a different deployment. The guard
 * fails closed BEFORE any read. (Codex review / cross-chain.)
 */
import { describe, expect, it } from 'vitest'
import { EfsError } from '../src/errors.js'
import type { ReadContext } from '../src/reads/context.js'
import { fetchRef } from '../src/reads/fetch.js'
import type { DataRef } from '../src/types.js'

const ref = (chainId: number): DataRef =>
  ({
    __brand: 'DataRef',
    uid: `0x${'ab'.repeat(32)}`,
    chainId,
    resolvedBy: '0x000000000000000000000000000000000000a11e',
  }) as DataRef

// Only `deployment.chainId` is read before the guard trips — the rest is never reached.
const ctxForChain = (chainId: number): ReadContext =>
  ({ deployment: { chainId } }) as unknown as ReadContext

describe('fetchRef — cross-chain guard', () => {
  it('throws WrongChain when the ref chain differs from the client chain', async () => {
    const err = await fetchRef(ctxForChain(11_155_111), ref(1)).catch((e) => e)
    expect(err).toBeInstanceOf(EfsError)
    expect((err as EfsError).code).toBe('WrongChain')
    // Names both chains so the caller can see the mismatch.
    expect((err as Error).message).toMatch(/chain 1\b/)
    expect((err as Error).message).toMatch(/11155111/)
  })

  it('does NOT trip the chain guard when the chains match', async () => {
    // Chains match → passes the guard and proceeds to read (which then fails on the
    // bare mock ctx) — but NEVER with the WrongChain code.
    const err = await fetchRef(ctxForChain(1), ref(1)).catch((e) => e)
    expect((err as { code?: string } | undefined)?.code).not.toBe('WrongChain')
  })
})

describe('fetchRef — maxBytes cap validation', () => {
  // The downstream cap checks are `>` comparisons: NaN never trips them (an over-cap body
  // reads as in-bounds) and Infinity disables the 50 MB ceiling. A non-finite/non-positive
  // cap must be rejected BEFORE it becomes the fetch limit, before any read.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
    it(`rejects a non-finite/non-positive maxBytes (${bad}) with InvalidArgument`, async () => {
      const err = await fetchRef(ctxForChain(1), ref(1), { maxBytes: bad }).catch((e) => e)
      expect(err).toBeInstanceOf(EfsError)
      expect((err as EfsError).code).toBe('InvalidArgument')
      expect((err as Error).message).toMatch(/maxBytes/)
    })
  }

  it('accepts a finite positive maxBytes (passes the guard, no InvalidArgument)', async () => {
    // Valid cap → passes validation and proceeds to read (fails on the bare mock ctx) —
    // but never with InvalidArgument.
    const err = await fetchRef(ctxForChain(1), ref(1), { maxBytes: 1024 }).catch((e) => e)
    expect((err as { code?: string } | undefined)?.code).not.toBe('InvalidArgument')
  })
})
