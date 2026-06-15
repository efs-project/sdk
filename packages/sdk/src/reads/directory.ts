/**
 * Pure directory-read helpers (ADR-0011) — no network calls, fully unit-testable.
 *
 * These prepare and validate the arguments for the `EFSFileView` directory-page
 * reads (`getDirectoryPageFiltered` and its unfiltered siblings) so the eventual
 * `fs.list` body can route, reconcile, and fail-fast before issuing any RPC:
 *
 *   - Routing: non-empty `excludeTagDefs` ⇒ the filtered query
 *     (`getDirectoryPageFiltered`); empty ⇒ the unfiltered sibling (ADR-0011 §1).
 *   - `minWeights` reconciliation: derive an all-zero vector when omitted/mismatched
 *     so the on-chain `excludeTagDefs/minWeights length mismatch` revert never fires
 *     (ADR-0042 default weight = 0; ADR-0048).
 *   - Cap enforcement: fail fast on the on-chain caps (`attesters` 1-20,
 *     `excludeTagDefs` ≤ 8, `maxItems > 0`) with a typed {@link EfsError}.
 *
 * Imports are limited to viem (types only) and the SDK error tree.
 */

import type { Address, Hex } from 'viem'
import { EfsError } from '../errors.js'

/**
 * On-chain cap: `EFSFileView` rejects an attester list that is empty or has more
 * than this many entries (`MAX_ATTESTERS_PER_QUERY`). Mirrors the contract guard
 * (`require(attesters.length > 0 ...)` / `require(attesters.length <= ...)`).
 */
export const MAX_ATTESTERS_PER_QUERY = 20

/**
 * On-chain cap: `getDirectoryPageFiltered` rejects more than this many exclude
 * predicates (`MAX_EXCLUDE_TAGS_PER_QUERY`).
 */
export const MAX_EXCLUDE_TAGS_PER_QUERY = 8

/**
 * Route to the filtered query (`getDirectoryPageFiltered`) iff at least one
 * exclude predicate was given; otherwise the unfiltered sibling is used
 * (ADR-0011 §1). Pure predicate over the exclude list's length.
 */
export function shouldUseFilteredQuery(excludeTagDefs: readonly unknown[]): boolean {
  return excludeTagDefs.length > 0
}

/**
 * Reconcile the parallel `minWeights` vector against `excludeTagDefs`.
 *
 * The contract requires `minWeights.length === excludeTagDefs.length` and reverts
 * otherwise. When the caller supplies a vector of the matching length we pass it
 * through verbatim; otherwise (omitted, or any length mismatch) we derive an
 * all-zero `0n` vector of the correct length — the ADR-0042 default threshold,
 * which means "exclude on any non-negative-weight tag." This prevents the
 * `excludeTagDefs/minWeights length mismatch` revert.
 */
export function reconcileMinWeights(
  excludeTagDefs: readonly unknown[],
  minWeights?: readonly bigint[],
): bigint[] {
  if (minWeights !== undefined && minWeights.length === excludeTagDefs.length) {
    return [...minWeights]
  }
  return new Array<bigint>(excludeTagDefs.length).fill(0n)
}

/**
 * A directory-query argument violated an on-chain cap (ADR-0011, ADR-0048).
 * Surfaced before any RPC so the caller never round-trips into a contract revert.
 */
export class InvalidDirectoryQuery extends EfsError {
  override name = 'InvalidDirectoryQuery'
  constructor(message: string) {
    super(message, { code: 'InvalidArgument' })
  }
}

/**
 * Fail-fast validation of the on-chain caps for a directory query (ADR-0011 §Decision):
 *
 *   - `attesters`: non-empty and ≤ {@link MAX_ATTESTERS_PER_QUERY}.
 *   - `excludeTagDefs`: ≤ {@link MAX_EXCLUDE_TAGS_PER_QUERY}.
 *   - `maxItems`: `> 0`.
 *
 * Throws {@link InvalidDirectoryQuery} (code `'InvalidArgument'`) naming the
 * violated cap. Returns `void` on success.
 */
export function validateDirectoryQuery(args: {
  attesters: readonly unknown[]
  excludeTagDefs: readonly unknown[]
  maxItems: number | bigint
}): void {
  const { attesters, excludeTagDefs, maxItems } = args

  if (attesters.length === 0) {
    throw new InvalidDirectoryQuery(
      'A directory query needs at least one attester (lens) — the attesters list is empty.',
    )
  }
  if (attesters.length > MAX_ATTESTERS_PER_QUERY) {
    throw new InvalidDirectoryQuery(
      `Too many attesters: ${attesters.length} given, the on-chain cap (MAX_ATTESTERS_PER_QUERY) is ${MAX_ATTESTERS_PER_QUERY}.`,
    )
  }
  if (excludeTagDefs.length > MAX_EXCLUDE_TAGS_PER_QUERY) {
    throw new InvalidDirectoryQuery(
      `Too many exclude tags: ${excludeTagDefs.length} given, the on-chain cap (MAX_EXCLUDE_TAGS_PER_QUERY) is ${MAX_EXCLUDE_TAGS_PER_QUERY}.`,
    )
  }
  if (maxItems <= 0) {
    throw new InvalidDirectoryQuery(`maxItems must be greater than 0 (got ${maxItems.toString()}).`)
  }
}

// Reference the viem types so this module is the documented home of the
// directory-query argument shapes even before `fs.list` consumes them.
export type DirectoryQueryAttester = Address
export type DirectoryQueryExcludeTag = Hex
