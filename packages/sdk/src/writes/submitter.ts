/**
 * The **Submitter seam** — the single execution chokepoint
 * (sdk-wallet-architecture §Submitters). A `Submitter` takes a built
 * {@link FileWriteGraph} plan and delivers it, returning one normalized
 * {@link WriteReceipt}. The selector (`writes/select.ts`) picks which `Submitter`
 * a write runs through; `efs.fs.write` routes through the selected one rather than
 * hard-calling a strategy. This is the seam the deferred AA work extends: a
 * 5792 / 7702 / 4337 submitter implements this same interface and plugs in via the
 * selector WITHOUT touching the core write orchestrator.
 *
 * ## Today: one live strategy
 *
 * `Tier1Submitter` is the only implementation — it wraps the existing
 * {@link submitWriteTier1} (one `multiAttest` per DAG layer, any wallet) and the
 * receipt mapping (moved here from `writes/file.ts`). Behavior is identical to the
 * pre-seam path; the seam adds the `mechanism`/`gasless`/`reason` stamping the
 * design's honest-receipt principle (#6) calls for.
 *
 * ## Return-vs-throw normalization (Tier-1's existing contract)
 *
 * The design's end state is that every submitter RETURNS a receipt whose `status`
 * reflects `confirmed`/`partial`/`reverted` (a thrown partial loses the landed-UID
 * `steps[]`). Tier-1 today instead THROWS {@link WriteRevertedError} at the
 * partial-write boundary — that is its existing contract, and callers depend on the
 * typed error carrying `layer`/`failedRefs`/`landed`. We deliberately keep throwing
 * it here (do NOT swallow it into a `partial` receipt): normalizing Tier-1's
 * throw→receipt is a separate, behavior-changing slice. So `Tier1Submitter.submit`
 * resolves to a `confirmed` receipt or propagates `WriteRevertedError` verbatim —
 * exactly as `writeFileTier1` did before the seam.
 */

import type { Address } from 'viem'
import type { ContentHash } from '../content/hash.js'
import { EfsError } from '../errors.js'
import type { DataRef, DataUID, WriteMechanism, WriteReceipt, WriteRoles } from '../types.js'
import type { FileWriteGraph } from './graph.js'
import {
  type SubmitContext,
  type Tier1WriteResult,
  assertAttesterIsSigner,
  submitWriteTier1,
} from './submit.js'

/**
 * The execution context a {@link Submitter} needs to deliver a plan and build the
 * public receipt. The chain/wallet plumbing ({@link SubmitContext}) plus the
 * receipt-shaping inputs the orchestrator already computed (the content hash, the
 * chain id, and the attester whose lens the write authors under).
 *
 * Narrow + viem-decoupled (it composes the existing structural
 * `SubmitWalletClient`/`SubmitPublicClient` surfaces), so a submitter is mockable
 * exactly like {@link submitWriteTier1}.
 */
export interface SubmitterContext extends SubmitContext {
  /** The file's content-identity hash (stamped onto the receipt). */
  readonly contentHash: ContentHash
  /** The EIP-155 chain id the resulting `DataRef` resolves on. */
  readonly chainId: number
  /** The attester the receipt records (lenses key on it). */
  readonly attester: Address
  /** Role overrides for the receipt's {@link WriteRoles} (ADR-0019/R4), for the
   * deferred AA/relay submitters (mechanism 'gateway'/'erc4337') to record
   * payer/submitter divergence. {@link Tier1Submitter} honors NONE of them: it
   * is self-submitted, so every role is `attester`, and it REFUSES a context
   * whose overrides say otherwise rather than stamping a false receipt. */
  readonly roles?: Partial<WriteRoles>
  /** Wallet transactions the on-chain storage step sent BEFORE the EAS layers (chunk +
   * manager deploys on the default `fs.write(path, bytes)` path; `0`/omitted when the
   * caller supplied mirrors). Folded into `signatureCount` so the receipt reports the
   * honest wallet-confirmation count, not just the attestation layers. */
  readonly storageTxCount?: number
}

/**
 * Delivers a built {@link FileWriteGraph} plan, returning one normalized
 * {@link WriteReceipt}. The execution seam the selector targets and the deferred
 * AA submitters (5792/7702/4337) implement.
 */
export interface Submitter {
  /** The mechanism this submitter delivers with (stamped onto the receipt). */
  readonly mechanism: WriteMechanism
  /** Execute the plan. Resolves to a receipt; Tier-1 propagates
   * `WriteRevertedError` at the partial-write boundary (see module doc). */
  submit(plan: FileWriteGraph, ctx: SubmitterContext): Promise<WriteReceipt>
}

/**
 * Map a {@link Tier1WriteResult} to the public {@link WriteReceipt} (moved from
 * `writes/file.ts`). The receipt's `data` ref points at the file's content-identity
 * DATA UID, resolved by the attester; `steps` records every minted attestation
 * (ref → UID, all `done`). Stamps the Tier-1 mechanism/gasless/reason.
 */
function toReceipt(result: Tier1WriteResult, ctx: SubmitterContext): WriteReceipt {
  // DATA is the static content ref; for a hardlink it pre-existed and the
  // submitter returns `dataUID: undefined`, so there is no fresh DATA to ref.
  const data: DataRef | undefined =
    result.dataUID !== undefined
      ? {
          __brand: 'DataRef',
          profile: 'efs/v1',
          uid: result.dataUID as DataUID,
          chainId: ctx.chainId,
          resolvedBy: ctx.attester,
        }
      : undefined

  // Separated roles (ADR-0019/R4). On Tier-1 they are DERIVED, never taken from
  // the caller: `assertTier1Roles` has already established that `ctx.attester`
  // is the wallet that signs, and a self-submitted wallet write is also the one
  // that pays and broadcasts. `submitter` stays ABSENT — its whole meaning is
  // "a relay stood in for the author", and there is none here.
  const roles: WriteRoles = {
    author: ctx.attester,
    signer: ctx.attester,
    payer: ctx.attester,
  }

  const steps = [...result.uids.entries()].map(([id, uid]) => ({
    id,
    // Raw attestation UID (kind given by `id`) — NOT branded DataUID (see WriteReceipt).
    uid,
    done: true,
  }))

  return {
    profile: 'efs/v1',
    roles,
    contentHash: ctx.contentHash,
    ...(data !== undefined ? { data } : {}),
    steps,
    // Honest wallet-confirmation count: the EAS attestation layers PLUS the on-chain
    // storage deploys (chunk + manager) the orchestrator sent before them.
    signatureCount: result.layerTxHashes.length + (ctx.storageTxCount ?? 0),
    mechanism: 'sequential',
    status: 'confirmed',
    gasless: false,
    reason: { selected: 'sequential', why: 'dependent-dag-needs-sequential' },
  }
}

/**
 * Refuse a Tier-1 submission whose `ctx.roles` claims a role the transaction
 * will not actually have (r3742238097).
 *
 * Tier-1 is self-submitted by definition — one wallet signs, pays and
 * broadcasts — so every role IS `ctx.attester`. Honoring an override would put
 * a false author/signer/payer/relay on a CONFIRMED receipt, and the receipt is
 * the durable artifact third parties trust. Rejecting rather than silently
 * dropping the override: a caller who set it holds a wrong model of what this
 * path does, and the deferred AA/relay submitters — which legitimately diverge
 * `payer`/`submitter` — are where those overrides belong.
 */
function assertTier1Roles(ctx: SubmitterContext): void {
  const wrong = Object.entries(ctx.roles ?? {}).filter(
    ([, addr]) => typeof addr === 'string' && addr.toLowerCase() !== ctx.attester.toLowerCase(),
  )
  if (wrong.length === 0) return
  const named = wrong.map(([role, addr]) => `${role}=${String(addr)}`).join(', ')
  throw new EfsError(
    `EFS write: this Tier-1 submission declares roles that diverge from the signing account ${ctx.attester} (${named}). Tier-1 is self-submitted — the wallet that signs also pays and broadcasts — so the receipt would claim a transaction that did not happen. Drop the override, or use an AA/relay submitter (mechanism 'gateway'/'erc4337'), which is where payer/submitter divergence is real.`,
    { code: 'InvalidArgument' },
  )
}

/**
 * The Tier-1 (any-wallet, multi-signature) submitter — the only live strategy.
 * Wraps {@link submitWriteTier1} (one `multiAttest` per DAG layer) and the receipt
 * mapping. A single file's dependent DAG can't be statically batched, so 5792
 * atomic does not apply — hence the `'dependent-dag-needs-sequential'` reason.
 */
export const Tier1Submitter: Submitter = {
  mechanism: 'sequential',
  async submit(plan: FileWriteGraph, ctx: SubmitterContext): Promise<WriteReceipt> {
    // The declared attester MUST be the signer (r3741867406): it becomes the
    // receipt's roles AND `DataRef.resolvedBy`, so a mismatch yields refs that
    // read under the wrong lens.
    assertAttesterIsSigner(ctx, ctx.attester)
    assertTier1Roles(ctx)
    // Propagates `WriteRevertedError` verbatim at the partial-write boundary —
    // Tier-1's existing return-vs-throw contract (see module doc).
    const result = await submitWriteTier1(plan, ctx)
    return toReceipt(result, ctx)
  },
}
