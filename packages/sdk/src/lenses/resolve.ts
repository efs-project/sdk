/**
 * Lenses (ADR-0031/0039). A lens is a *resolved, ordered set of attester addresses*
 * (first-wins), not a bare address. The type is opaque so richer resolution
 * (ENS → a person's device key-set) can drop in later without breaking callers.
 * Resolution is always async and happens at read time.
 */

import type { Address, PublicClient } from 'viem'
import { isAddress } from 'viem'
import { normalize } from 'viem/ens'
import { EfsError, MaxLensesExceeded } from '../errors.js'

/** Cap on lens-stack size (contracts ADR-0026, renamed MAX_EDITIONS). */
export const MAX_LENSES = 20

export type LensContext = { publicClient?: PublicClient }

export type Lens = {
  readonly __brand: 'Lens'
  /** Resolve to the ordered attester set. Order is load-bearing (first-wins). */
  resolve(ctx: LensContext): Promise<readonly Address[]>
}

/** Dedupe (case-insensitive, order-preserving) and enforce the cap by THROWING —
 * never truncating, which would silently change which attester wins (review S2). */
function finalize(addresses: readonly Address[]): readonly Address[] {
  const seen = new Set<string>()
  const out: Address[] = []
  for (const a of addresses) {
    const key = a.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(a)
    }
  }
  if (out.length > MAX_LENSES) throw new MaxLensesExceeded(out.length, MAX_LENSES)
  return out
}

/** A literal lens — exactly these addresses, in this order, never expanded.
 * The caller orders them (their own wallet typically first). */
export function lens(addresses: Address | readonly Address[]): Lens {
  const arr: readonly Address[] = Array.isArray(addresses) ? addresses : [addresses]
  const resolved = finalize(arr) // validate the cap eagerly (fail fast)
  return { __brand: 'Lens', resolve: async () => resolved }
}

/** An identity that may expand. v1: an address resolves to itself; an ENS name
 * resolves to its address. Multi-device key-set expansion (the webOfTrust tier)
 * drops in here later WITHOUT changing this signature. */
export function identity(ensOrAddress: string): Lens {
  return {
    __brand: 'Lens',
    resolve: async ({ publicClient }) => {
      if (isAddress(ensOrAddress)) return finalize([ensOrAddress])
      if (!publicClient) {
        throw new EfsError(`Resolving the ENS name "${ensOrAddress}" needs a publicClient.`)
      }
      const addr = await publicClient.getEnsAddress({ name: normalize(ensOrAddress) })
      if (!addr) throw new EfsError(`ENS name "${ensOrAddress}" did not resolve to an address.`)
      return finalize([addr])
    },
  }
}

/** Coerce a Lens or a raw address into resolved attesters. A raw address is
 * treated as a literal single-address lens. The output is ALWAYS finalized
 * (deduped + capped) here: the `Lens` type is structurally open, so a CUSTOM
 * lens's `resolve()` can return duplicates or an over-cap set that the
 * built-in constructors finalize internally — this common boundary is where
 * every read's attester set is produced, so it enforces the same contract for
 * every lens source (the documented {@link MaxLensesExceeded}, never a
 * downstream contract/RPC failure; `resolveAttesters()`' promised dedup holds).
 * Idempotent for the built-ins. */
export async function resolveLens(
  input: Lens | Address,
  ctx: LensContext,
): Promise<readonly Address[]> {
  const l = typeof input === 'string' ? lens(input) : input
  return finalize(await l.resolve(ctx))
}
