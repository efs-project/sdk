/**
 * **Selection** (sdk-wallet-architecture §Selection) — the pure function that picks
 * which {@link Submitter} a write runs through, given the detected
 * {@link AccountProfile} and the built plan. No I/O; fixture-testable.
 *
 * `selectSingle` is the single-file entry point. It encodes the design's priority
 * ladder: an in-account routine (one signature) when the account can run one,
 * else Tier-1 (the guaranteed floor). A single file's dependent DAG can't be
 * statically batched, so EIP-5792 atomic does NOT apply here — only the in-account
 * routine or Tier-1 are candidates for a single file (the 5792 atomic path is
 * `selectBatch`'s, a deferred slice).
 *
 * Today there are NO in-account adapters, so `canRunInAccountRoutine` is always
 * `false` and this always returns {@link Tier1Submitter}. The ladder STRUCTURE is
 * in place so the deferred AA work plugs its in-account submitter into the first
 * branch without touching the core — the seam, not a behavior change.
 */

import type { AccountProfile } from '../types.js'
import type { FileWriteGraph } from './graph.js'
import { type Submitter, Tier1Submitter } from './submitter.js'

/**
 * Pick the {@link Submitter} for a single-file write. The priority ladder:
 *
 *   1. **In-account routine** — if `profile.canRunInAccountRoutine`, the account
 *      can run the EFS routine in its own context for a one-signature write. (No
 *      adapter supplies this yet, so this branch is currently never taken.)
 *   2. **Tier-1** — the any-wallet, multi-signature floor. The default and, today,
 *      the only outcome.
 *
 * Pure — `plan` is accepted for the ladder's shape (a future strategy may inspect
 * the DAG, e.g. a single-layer no-symbol plan) but is not needed to choose Tier-1.
 */
export function selectSingle(profile: AccountProfile, _plan: FileWriteGraph): Submitter {
  // 1. In-account one-sig routine — the deferred AA submitter plugs in here.
  if (profile.canRunInAccountRoutine) {
    // No in-account adapter is wired yet; `detectAccount` never sets this true, so
    // this is unreachable today. When the AA slice lands it returns the account's
    // in-account submitter (resolved on the profile) instead of falling through.
    return Tier1Submitter
  }

  // 2. Tier-1 — the guaranteed floor (the only live strategy).
  return Tier1Submitter
}
