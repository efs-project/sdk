/**
 * SORT overlay reads — `efs.sorts.*` (sorted views over kernel child arrays).
 *
 * @experimental — DEFERRED, NOT YET READABLE. The SORT_INFO schema and its
 * `EFSSortOverlay` resolver are NOT part of the frozen Sepolia set: SORT_INFO was
 * deferred (it can be added later without orphaning anything — see
 * `chain/deployments.ts` `EfsSchemaUIDs`, which deliberately omits `sortInfo`, and
 * `EfsContracts`, which has no `sortOverlay` address). Because the schema is not
 * frozen and the overlay is not in the deployments registry, there is nothing stable
 * to read against — the on-chain encoding (`address sortFunc, bytes32 targetSchema,
 * uint8 sourceType` + the shared doubly-linked-list traversal in
 * `EFSSortOverlay.getSortedChunkByAddressList`) could still change before it lands.
 *
 * Rather than guess that encoding, every verb here throws {@link NotImplemented}
 * with a clear pointer. The namespace + signatures are present so the real
 * implementation drops in additively (a new top-level namespace / new methods are
 * non-breaking) once SORT_INFO is frozen and seeded into the registry. The TODO
 * below tracks the wiring the real implementation needs.
 *
 * TODO(sorts): when SORT_INFO is frozen + deployed —
 *   1. add `sortOverlay: Address` to {@link EfsContracts} and `sortInfo: Hex` to
 *      {@link EfsSchemaUIDs} (`chain/deployments.ts`); seed both from the deploy.
 *   2. vendor the `EFSSortOverlay` read ABI (`getSortInfo`/`getSortedChunkByAddressList`/
 *      `getSortStaleness`) in `chain/abi/`.
 *   3. implement `get(sortInfoUID)` (decode `sortFunc`/`targetSchema`/`sourceType`)
 *      and `apply(parentAnchor, sortInfoUID, { lens })` → ordered entries via the
 *      lens-scoped `getSortedChunkByAddressList`, paged like `fs.list`.
 *   4. replace the throws below; keep the signatures.
 */

import type { Address, Hex } from 'viem'
import { NotImplemented } from '../errors.js'

/** Where a sort draws its items from (`uint8 sourceType` on SORT_INFO): all children
 * of a parent anchor, or only children of one schema. Reserved for the real impl. */
export type SortSourceType = 'children' | 'children-by-schema'

/**
 * A declared SORT_INFO — the `efs.sorts.get` result (reserved shape; not yet
 * populated). Decoded from the SORT_INFO attestation once the schema is frozen.
 */
export type SortInfo = {
  sortInfoUID: Hex
  exists: boolean
  /** The `ISortFunc` contract that defines the ordering. */
  sortFunc: Address
  /** Which schema the sort targets (`bytes32(0)` = all children). */
  targetSchema: Hex
  /** Where items are drawn from (`sourceType`). */
  sourceType: SortSourceType
}

/** Options for the (deferred) sort reads — lens-scoped at read time, like `fs.list`. */
export type SortReadOptions = {
  lens?: Address | readonly Address[]
  limit?: number
  cursor?: string
}

/** The shared throw — one message, one tracking note, for every deferred verb. */
function deferred(verb: string): never {
  throw new NotImplemented(`efs.sorts.${verb}`, {
    alternative:
      'the SORT overlay (SORT_INFO) is deferred and not yet in the frozen schema set / deployments registry, so there is no stable on-chain encoding to read. Use efs.lists.* for curated ordering today; sorts land additively once SORT_INFO is frozen + deployed.',
  })
}

/**
 * `efs.sorts.get(sortInfoUID, opts?)` — the declared sort's config.
 * @experimental — throws {@link NotImplemented} until SORT_INFO is frozen + deployed.
 */
export async function getSort(_sortInfoUID: Hex, _opts?: SortReadOptions): Promise<SortInfo> {
  return deferred('get')
}

/**
 * `efs.sorts.apply(parentAnchor, sortInfoUID, opts?)` — the parent's children in the
 * sort's order, lens-scoped.
 * @experimental — throws {@link NotImplemented} until SORT_INFO is frozen + deployed.
 */
export async function applySort(
  _parentAnchor: Hex,
  _sortInfoUID: Hex,
  _opts?: SortReadOptions,
): Promise<never> {
  return deferred('apply')
}
