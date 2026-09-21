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
import { decodeAbiParameters } from 'viem'
import { edgeResolverAbi } from '../chain/abi/edgeResolver.js'
import type { EfsDeployment } from '../chain/deployments.js'
import { getAttestationAbi } from '../eas/abi.js'
import { EfsError } from '../errors.js'
import { read } from '../reads/context.js'
import type { ReadPublicClient } from '../reads/context.js'
import { ZERO_UID } from '../reads/context.js'
import { hasActiveMirror } from '../reads/mirror-scan.js'
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
      const ctx = deps.submitContext()
      // Fail closed on a wrong-chain provider BEFORE the gate read below — the
      // attestation we validate against must come from the deployment chain.
      await ctx.assertChain?.()
      const dep = deps.getDeployment()
      const pc = deps.guardReadClient?.(dep.chainId) ?? deps.publicClient
      // TS parity with Solidity EFSLib.place (r3741216395 / r3741216397): the
      // PIN is authored by the CONNECTED account, and lens-scoped reads resolve
      // mirrors/properties under the placement attester — placing FOREIGN DATA
      // yields a visible-but-unreadable file (ForeignDataUID), and a non-DATA
      // target pins into the wrong schema slot, invisible to `pins.active()`
      // and file resolution (NotDataUID).
      const [att, anchorAtt] = await Promise.all([
        read<{ attester: Address; schema: Hex }>(pc, {
          address: dep.contracts.eas,
          abi: getAttestationAbi,
          functionName: 'getAttestation',
          args: [dataUID],
        }),
        read<{ schema: Hex; data: Hex }>(pc, {
          address: dep.contracts.eas,
          abi: getAttestationAbi,
          functionName: 'getAttestation',
          args: [anchor],
        }),
      ])
      if (att.attester.toLowerCase() !== ctx.attester.toLowerCase()) {
        throw new EfsError(
          `efs.graph.pins.place: the DATA ${dataUID} is authored by ${att.attester}, not the connected account ${ctx.attester} — a foreign placement resolves to a file whose mirrors/properties are INVISIBLE under your lens (unreadable, unverifiable). Re-publish the bytes as your own write instead.`,
          { code: 'InvalidArgument' },
        )
      }
      if (att.schema.toLowerCase() !== dep.schemas.data.toLowerCase()) {
        throw new EfsError(
          `efs.graph.pins.place: the target ${dataUID} is not a DATA attestation (schema ${att.schema}) — the PIN would index under that schema while pins.active() and file resolution read the DATA slot: a confirmed receipt for an invisible placement.`,
          { code: 'InvalidArgument' },
        )
      }
      // The DEFINITION must be an ANCHOR (r3741271349): EdgeResolver accepts any
      // existing attestation as a PIN definition, but fs.* discovers placements
      // by resolving a DATA-bucket ANCHOR first and only then reading its PIN
      // slot — a PROPERTY/DATA (or nonexistent) definition confirms a placement
      // no path resolution can ever find.
      if (anchorAtt.schema.toLowerCase() !== dep.schemas.anchor.toLowerCase()) {
        throw new EfsError(
          `efs.graph.pins.place: the definition ${anchor} is not an ANCHOR attestation (schema ${anchorAtt.schema}) — path resolution discovers placements through ANCHOR nodes only, so this PIN would confirm but never be found.`,
          { code: 'InvalidArgument' },
        )
      }
      // The anchor must live in the DATA FILE BUCKET (r3741358639): file
      // resolution finds terminals via `resolveAnchor(parent, name, DATA)`, so
      // a generic-folder or PROPERTY-key ANCHOR (right schema, wrong bucket)
      // yields an undiscoverable placement.
      let anchorBucket: Hex
      try {
        const decoded = decodeAbiParameters(
          [{ type: 'string' }, { type: 'bytes32' }],
          anchorAtt.data,
        ) as [string, Hex]
        anchorBucket = decoded[1]
      } catch {
        throw new EfsError(
          `efs.graph.pins.place: the definition ${anchor}'s payload does not decode as (name, forSchema) — it does not name a file slot.`,
          { code: 'InvalidArgument' },
        )
      }
      if (anchorBucket.toLowerCase() !== dep.schemas.data.toLowerCase()) {
        throw new EfsError(
          `efs.graph.pins.place: the definition ${anchor} lives in bucket ${anchorBucket}, not the DATA file bucket — file resolution can never discover this placement (folder/typed anchors are not file slots).`,
          { code: 'InvalidArgument' },
        )
      }
      // READABILITY proof (r3741250932) — same rule as the hardlink gate:
      // authorship + schema still admit a BARE self-authored DATA (raw EAS
      // verbs, or all mirrors since revoked), whose placement confirms and then
      // fails every read() with AllMirrorsFailed. Require >=1 ACTIVE mirror
      // authored by the connected account, scanning raw-count-bounded filtered
      // windows (the reads/mirror-scan.ts InvalidOffset boundary) with a
      // first-hit exit.
      const mirrored = await hasActiveMirror(
        pc,
        { indexer: dep.contracts.indexer, mirrorSchema: dep.schemas.mirror },
        dataUID,
        ctx.attester,
      )
      if (!mirrored) {
        throw new EfsError(
          `efs.graph.pins.place: the DATA ${dataUID} has NO active mirror authored by ${ctx.attester} — the placement would confirm but every read() fails AllMirrorsFailed. Attest a mirror via efs.mirrors.add (or publish via fs.write), then place.`,
          { code: 'InvalidArgument' },
        )
      }
      const plan = buildPlacementPinPlan(dep.schemas, anchor, dataUID)
      return submitEdgePlan(plan, ctx)
    },

    unplace: async (pinUID) => {
      const dep = deps.getDeployment()
      return deps.revoke(dep.schemas.pin, pinUID)
    },

    active: async (anchor, attester) => {
      const dep = await (deps.liveDeployment ?? deps.getDeployment)()
      const who = attester ?? deps.attester()
      // No effective attester is NOT an empty slot (r3741157009): returning
      // undefined here would report a false absence for a read that never
      // happened. Match the other standalone namespaces' contract.
      if (who === undefined)
        throw new EfsError(
          'efs.graph.pins.active: no attester supplied and no connected account.',
          { code: 'LensRequired' },
        )
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
