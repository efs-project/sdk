/**
 * Shared submit + receipt mapping for the standalone edge/value writes
 * (`graph.tags`, `props`, `graph.pins`). They route through the SAME Tier-1
 * execution path as `fs.write` — `submitLayeredTier1` (one `multiAttest` per DAG
 * layer) — and normalize the raw `ref → UID` map into a public {@link WriteReceipt}.
 *
 * These plans are 1–2 layers (a TAG/PIN is one; the PROPERTY triple is two), so the
 * receipt's `signatureCount` is honestly the number of layers the plan ran — one
 * popup per layer on a Tier-1 wallet. There is no content, so `contentHash`/`data`
 * are omitted (the receipt shape is shared but content-specific fields are absent).
 *
 * The selector seam is consulted exactly as `fs.write` does (`selectSingle` → today
 * always `Tier1Submitter`), but the edge/value plans don't need the file submitter's
 * placement-PIN projection, so they call `submitLayeredTier1` directly. When an
 * in-account one-sig adapter lands, these collapse to one signature through the same
 * seam without a change here.
 */

import type { Address } from 'viem'
import type { DataUID, WriteReceipt } from '../types.js'
import type { FileWriteGraph } from './graph.js'
import { type LayeredWriteResult, type SubmitContext, submitLayeredTier1 } from './submit.js'

/** The chain/wallet context an edge/value submit needs (the file write's
 * {@link SubmitContext} plus the attester the receipt records). */
export interface EdgeSubmitContext extends SubmitContext {
  /** The EIP-155 chain id (informational; carried for parity with file writes). */
  readonly chainId: number
  /** The attester the write authors under (the connected wallet). */
  readonly attester: Address
}

/**
 * Submit a built edge/value plan through the Tier-1 layered path and map the result
 * to a normalized {@link WriteReceipt}. `steps` records every minted attestation
 * (`ref → UID`, all `done`); `signatureCount` is the layer/tx count (the honest
 * popup count); `mechanism`/`gasless`/`reason` mirror the file write's Tier-1 stamp.
 *
 * @throws {WriteRevertedError} on a layer revert (the partial-write boundary).
 */
export async function submitEdgePlan(
  plan: FileWriteGraph,
  ctx: EdgeSubmitContext,
): Promise<WriteReceipt> {
  const result: LayeredWriteResult = await submitLayeredTier1(plan, ctx)
  return toEdgeReceipt(result)
}

/** Map a {@link LayeredWriteResult} to the public {@link WriteReceipt} (no content
 * → no `contentHash`/`data`). */
function toEdgeReceipt(result: LayeredWriteResult): WriteReceipt {
  const steps = [...result.uids.entries()].map(([id, uid]) => ({
    id,
    uid: uid as DataUID,
    done: true,
  }))
  return {
    steps,
    signatureCount: result.layerTxHashes.length,
    mechanism: 'sequential',
    status: 'confirmed',
    gasless: false,
    reason: { selected: 'sequential', why: 'dependent-dag-needs-sequential' },
  }
}
