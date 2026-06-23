/**
 * `efs.graph.pins` — the standalone placement **PIN** primitive (place / unplace).
 *
 * A placement PIN is a cardinality-1 edge `PIN(definition = anchor, refUID =
 * dataUID)` from the connected attester (EdgeResolver.sol; ADR-0041) — the same
 * shape the file-write DAG emits to place a file's DATA under its anchor.
 *
 *  - `place(anchor, dataUID)` — pin `dataUID` at `anchor` (ONE signature). Cardinality
 *    1: a new PIN at the same `(attester, anchor, DATA_SCHEMA_UID)` slot SUPERSEDES the
 *    prior placement in O1, so `place` replaces whatever was active there.
 *  - `unplace(pinUID)` — revoke a placement PIN (via `efs.eas.revoke`, PIN schema),
 *    clearing the slot.
 *  - `active(anchor, attester)` — read the active PIN's target DATA UID at a slot
 *    (`getActivePinTarget`), revoked excluded.
 *
 * The write routes through the SAME Submitter seam as `fs.write` (`submitEdgePlan`);
 * the read reuses the vendored `EdgeResolver` ABI.
 */

import type { Address, Hex } from 'viem'
import { edgeResolverAbi } from '../chain/abi/edgeResolver.js'
import type { EfsDeployment } from '../chain/deployments.js'
import { read } from '../reads/context.js'
import type { ReadPublicClient } from '../reads/context.js'
import { ZERO_UID } from '../reads/context.js'
import type { WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlan } from './edge-submit.js'
import { buildPlacementPinPlan } from './edge.js'

/** The `efs.graph.pins` write+read surface (present only on a write-capable client). */
export interface PinsNs {
  /** Place `dataUID` under `anchor` (a cardinality-1 placement PIN). Supersedes the
   * prior active placement at that slot. One signature. */
  place(anchor: Hex, dataUID: Hex): Promise<WriteReceipt>
  /** Revoke a placement PIN by its attestation UID (via `efs.eas.revoke`, PIN schema). */
  unplace(pinUID: Hex): Promise<Hex>
  /** The active PIN target (DATA UID) at `(anchor, attester)` — `undefined` when the
   * slot is empty. Defaults `attester` to the connected attester. */
  active(anchor: Hex, attester?: Address): Promise<Hex | undefined>
}

/** Dependencies the `pins` namespace binds to (built once by the client). */
export interface PinsNsDeps {
  readonly getDeployment: () => EfsDeployment
  /** Resolve the deployment from the LIVE provider chain for the `active` READ (a mutable
   * provider can switch chains after construction). Falls back to {@link PinsNsDeps.getDeployment}
   * when omitted (unit tests). Write methods keep `getDeployment`. */
  readonly liveDeployment?: () => EfsDeployment | Promise<EfsDeployment>
  readonly publicClient: ReadPublicClient
  /** Wrap {@link PinsNsDeps.publicClient} with a guard pinned to the LIVE-resolved deployment
   * chain, so a read fails closed (`WrongChain`) if the provider drifts between
   * `liveDeployment()` and the `readContract` below (TOCTOU). Falls back to the unguarded
   * client when omitted (unit tests). */
  readonly guardReadClient?: (chainId: number) => ReadPublicClient
  readonly submitContext: () => EdgeSubmitContext
  /** The connected attester (default lens for the active read). */
  readonly attester: () => Address | undefined
  /** Revoke a UID under a schema (wired to `efs.eas.revoke`). */
  readonly revoke: (schema: Hex, uid: Hex) => Promise<Hex>
}

/** Construct the `efs.graph.pins` namespace bound to a client's deps. */
export function makePinsNs(deps: PinsNsDeps): PinsNs {
  return {
    place: async (anchor, dataUID) => {
      const dep = deps.getDeployment()
      const plan = buildPlacementPinPlan(dep.schemas, anchor, dataUID)
      return submitEdgePlan(plan, deps.submitContext())
    },

    unplace: async (pinUID) => {
      const dep = deps.getDeployment()
      return deps.revoke(dep.schemas.pin, pinUID)
    },

    active: async (anchor, attester) => {
      const dep = await (deps.liveDeployment ?? deps.getDeployment)()
      const who = attester ?? deps.attester()
      if (who === undefined) return undefined
      // Guard against a chain switch between resolving `dep` and this read (TOCTOU).
      const pc = deps.guardReadClient?.(dep.chainId) ?? deps.publicClient
      const target = await read<Hex>(pc, {
        address: dep.contracts.edgeResolver,
        abi: edgeResolverAbi,
        functionName: 'getActivePinTarget',
        // (definition = anchor, attester, targetSchema = DATA)
        args: [anchor, who, dep.schemas.data],
      })
      return target === ZERO_UID ? undefined : target
    },
  }
}
