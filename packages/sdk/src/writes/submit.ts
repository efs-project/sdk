/**
 * **Tier-1 (multi-signature, any-wallet) write submitter.**
 *
 * Takes a {@link FileWriteGraph} write plan (from `buildFileWriteGraph`) and
 * executes it as **one EAS `multiAttest` per dependency layer**, threading the
 * real mined UIDs from each layer into the symbolic references of the next. This
 * is the universal fallback path: it needs nothing from the wallet beyond plain
 * `attest`/`multiAttest` transactions, so it works on every wallet (no EIP-7702
 * batched-auth or EIP-5792 `wallet_sendCalls` required — those power the
 * one-signature Tier-2/Tier-0 paths).
 *
 * ## Why layer-by-layer (the UID-threading problem)
 *
 * A fresh attestation's EAS UID embeds `block.timestamp` (+ a collision bump), so
 * it is unknowable until mined (`EAS.sol` `_getUID`). When attestation B must
 * carry attestation A's UID (B's `refUID`, or a PIN's in-`data` `definition`), B
 * cannot be sent in the same tx as A using A's *real* UID. The graph models this
 * with {@link SymbolicRef}s; the submitter resolves them tier-by-tier:
 *
 *   1. Group the plan by layer (1 → 2 → 3).
 *   2. For each layer, in order: resolve every symbolic `refUID` / in-data
 *      `definition` against the {@link RefMap} of UIDs minted in *prior* layers,
 *      re-encoding any PIN `data` whose `definition` was symbolic; send one
 *      `multiAttest` for the whole layer.
 *   3. After the layer's tx mines, parse the EAS `Attested` events out of the
 *      receipt (one per attestation, **in submission order**) and record each
 *      layer attestation's `ref → real UID` into the map.
 *
 * Layer N+1's symbols are guaranteed (by the graph's construction) to reference
 * only layers ≤ N, so the map is always fully populated when a symbol is resolved.
 *
 * ## Extracting UIDs from the receipt — submission-order zip
 *
 * EAS's `multiAttest` emits exactly one `Attested(recipient, attester, uid,
 * schemaUID)` per created attestation, in the flattened order it iterated the
 * request: `requests[0].data[0..]`, then `requests[1].data[0..]`, etc. viem's
 * `parseEventLogs` returns the decoded logs in block/receipt order, which is that
 * same emission order. So the submitter keeps a **parallel flat array of refs**
 * in the identical flattened order it built the `multiAttest` requests, then zips
 * it against the parsed `Attested` UIDs. (It does NOT zip against the original
 * `PlannedAttestation` order — grouping-by-schema can reorder entries, so the
 * flat ref array is captured at request-build time, not assumed.)
 *
 * Robustness: the EAS contract is the only emitter of its `Attested` event, but a
 * resolver or a co-batched contract is not in play here (one `multiAttest` to the
 * EAS address), so every `Attested` in the receipt belongs to this call. The
 * submitter still filters by the EAS address and asserts the count matches the
 * layer size — a mismatch is a hard error (the receipt is not what we sent).
 *
 * ## Partial-write boundary
 *
 * Each layer is its own transaction and its own atomic unit (a resolver revert
 * reverts the *whole* layer tx — EFS resolvers `revert`/`return false`). If layer
 * K reverts, layers < K already mined: the file is **half-written** (e.g. DATA +
 * anchors exist but the placement PIN never landed, so the file is not yet
 * visible). The submitter surfaces this as a typed {@link WriteRevertedError}
 * carrying the failed layer, the refs in that layer, and the UIDs that *did* land
 * in earlier layers — the caller's recovery/resume signal.
 *
 * ## Hardlink plans — one signature
 *
 * A hardlink plan (`buildFileWriteGraph` with `content.kind === 'hardlink'`) has a
 * pre-existing concrete DATA UID and no cross-layer symbolic `refUID` — only the
 * placement PIN's `definition` references the fresh file-ANCHOR. The submitter
 * still must thread that one symbol, so it runs the same layered loop; the file-
 * ANCHOR (L2) and placement PIN (L3) are different layers, so it is two txs in the
 * fully general case. The truly single-tx case is any plan whose attestations all
 * live in one layer with no symbols — the loop naturally collapses to one tx then.
 */

import type { Address, Hex, Log, TransactionReceipt } from 'viem'
import { parseEventLogs } from 'viem'
import { easAbi, getAttestationAbi } from '../eas/abi.js'
import { buildMultiAttest } from '../eas/attest.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'
import { EfsError, classifyError, isDefiniteSendRefusal } from '../errors.js'
import {
  type FileWriteGraph,
  type PlannedAttestation,
  REF,
  type RefOrUID,
  ZERO_ADDRESS,
  ZERO_UID,
  isSymbolicRef,
} from './graph.js'
import type { CompletedOnchainStorage } from './onchain.js'

/** A resolved `ref → mined UID` table, accumulated layer by layer. */
export type RefMap = ReadonlyMap<string, Hex>

/**
 * The minimal viem wallet surface the submitter needs: send a contract write and
 * get back a tx hash. Structurally satisfied by a viem `WalletClient` (its
 * `writeContract`); kept narrow so the submitter is trivially mockable and does
 * not couple to the full client type.
 */
export interface SubmitWalletClient {
  writeContract(args: {
    address: Address
    abi: typeof easAbi
    functionName: 'multiAttest'
    args: readonly [
      readonly {
        schema: Hex
        data: readonly {
          recipient: Address
          expirationTime: bigint
          revocable: boolean
          refUID: Hex
          data: Hex
          value: bigint
        }[]
      }[],
    ]
    value: bigint
    account?: unknown
    chain?: unknown
  }): Promise<Hex>
}

/**
 * The minimal viem public surface the submitter needs: wait for a receipt. The
 * receipt's `logs` carry the `Attested` events the submitter parses.
 */
export interface SubmitPublicClient {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>
  /** EAS read used by the HARDLINK self-authorship gate (a viem `PublicClient`
   * satisfies this). Optional so minimal byte-write contexts keep working —
   * but a HARDLINK plan submitted without it FAILS CLOSED (the gate cannot be
   * skipped; see {@link submitWriteTier1}). */
  readContract?(args: {
    address: Address
    abi: unknown
    functionName: string
    args: readonly unknown[]
  }): Promise<unknown>
}

/** Execution context for {@link submitWriteTier1}. */
export interface SubmitContext {
  /** Sends each layer's `multiAttest` (a viem `WalletClient` satisfies this). */
  readonly walletClient: SubmitWalletClient
  /** Waits for each layer's receipt (a viem `PublicClient` satisfies this). */
  readonly publicClient: SubmitPublicClient
  /** The EAS contract address to attest against. */
  readonly easAddress: Address
  /**
   * The signing account. viem's `writeContract` requires an `account` unless the
   * wallet client was created with one bound; forwarded verbatim when set.
   */
  readonly account?: unknown
  /**
   * The chain to assert against. viem's `writeContract` requires a `chain`
   * unless bound on the client; forwarded verbatim when set.
   */
  readonly chain?: unknown
  /** Optional progress hook, fired once per layer with the layer's outcome. */
  readonly onLayer?: (event: LayerResult) => void
  /**
   * Optional cancellation signal. Checked before each layer's irreversible
   * `multiAttest` — never mid-flight, since a tx already sent cannot be unsent.
   * Aborting between layers leaves a partial write (same boundary as a revert).
   */
  readonly signal?: AbortSignal
  /**
   * Optional live-chain assertion, re-run BEFORE each layer's `multiAttest` (not just
   * once at preflight). A multi-layer write fires one wallet confirmation per layer, so
   * an injected wallet can switch networks AFTER an earlier layer mined; without a
   * per-layer recheck the dependent layer would broadcast to the new chain while receipts
   * are still awaited on the deployment chain, leaving a partial write. The client wires
   * this to the wallet-vs-deployment chain guard (fails closed with `WrongChain`). Omitted
   * ⇒ no check (unit tests with a pre-validated mock).
   */
  readonly assertChain?: () => Promise<void>
}

/** What one layer's `multiAttest` produced. */
export interface LayerResult {
  /** The DAG layer (1 | 2 | 3). */
  readonly layer: number
  /** The layer's `multiAttest` tx hash. */
  readonly txHash: Hex
  /** The refs minted in this layer, in submission (event) order, with their UIDs. */
  readonly minted: readonly { readonly ref: string; readonly uid: Hex }[]
}

/** The structured result of a successful Tier-1 write. */
export interface Tier1WriteResult {
  /** Every created `ref → real UID`, across all layers. */
  readonly uids: RefMap
  /** Each layer's tx hash, in execution order (1 → 2 → 3). */
  readonly layerTxHashes: readonly Hex[]
  /** Per-layer breakdown (hash + minted refs), in execution order. */
  readonly layers: readonly LayerResult[]
  /** The file's content-identity DATA UID — the hardlink target for re-placement.
   * `undefined` for a hardlink plan (the DATA pre-existed; it is not re-minted). */
  readonly dataUID: Hex | undefined
  /** The placement-PIN UID — the attestation that makes the file visible at its path. */
  readonly placementPinUID: Hex
}

/**
 * Raised when a layer's `multiAttest` was SENT (a `txHash` exists) but did not
 * land cleanly — either the receipt wait failed ({@link WriteRevertedError.mined}
 * `=== false`: the tx may still mine later, a duplicate risk) or the receipt came
 * back `status: 'reverted'` ({@link WriteRevertedError.mined} `=== true`: it mined
 * and reverted). EITHER WAY a `txHash` is in flight, so the caller must NOT blindly
 * retry the whole write (it could double-submit the in-flight layer); the
 * {@link WriteRevertedError.txHash} is the handle to reconcile against the chain.
 *
 * The partial-write boundary still holds: layers before {@link WriteRevertedError.layer}
 * already mined (their UIDs are in {@link WriteRevertedError.landed}); this layer and
 * all later ones did not (cleanly). The file is half-written.
 *
 * For a failure where NO tx was ever sent (the `writeContract` call itself threw —
 * user rejection, wallet RPC error, preflight), see {@link WriteNotSentError}:
 * there is no `txHash` and nothing landed in this layer. For a receipt that
 * mined SUCCESSFULLY but whose `Attested` logs could not be decoded, see
 * {@link WriteUidsUnknownError}: those attestations DID mint — the opposite of
 * this class's contract.
 */
export class WriteRevertedError extends EfsError {
  /** The COMPLETED (irreversible) on-chain storage the write performed before
   * its EAS layers, when the auto-store path ran — attached by the fs.write
   * orchestrator so recovery reuses it (`storage.web3Uri` as an explicit
   * mirror) instead of paying for duplicate deploys. */
  storage?: CompletedOnchainStorage
  override name = 'WriteRevertedError'
  /** The DAG layer whose `multiAttest` was sent but did not land cleanly. */
  readonly layer: number
  /** The refs that were in the failed layer (none of which is known to have minted). */
  readonly failedRefs: readonly string[]
  /** The `ref → UID` table from layers that *did* land before the failure. */
  readonly landed: RefMap
  /** The in-flight tx hash for the failed layer. Always present (a tx WAS sent) —
   * the reconciliation handle. (`WriteNotSentError` is the no-tx counterpart.) */
  readonly txHash: Hex
  /**
   * `true`  — the tx MINED and reverted (`receipt.status === 'reverted'`): a
   *           deterministic on-chain failure, the layer definitively did not apply.
   * `false` — the tx was sent but the receipt WAIT failed (timeout/RPC): the tx may
   *           still mine later, so the layer's outcome is UNKNOWN (duplicate risk on
   *           a naive retry). Reconcile via {@link WriteRevertedError.txHash}. */
  readonly mined: boolean
  constructor(
    layer: number,
    failedRefs: readonly string[],
    landed: RefMap,
    txHash: Hex,
    mined: boolean,
    cause: unknown,
  ) {
    const classified = classifyError(cause)
    const phase = mined
      ? `mined and reverted (tx ${txHash})`
      : `sent but its receipt could not be confirmed (tx ${txHash} may still mine)`
    super(
      `EFS write failed at layer ${layer} — ${phase} (${failedRefs.length} attestation(s): ${failedRefs.join(', ')}). ` +
        `${landed.size} attestation(s) from earlier layers already landed — the file is partially written.`,
      { code: 'PartialBatchFailure', cause, details: classified.shortMessage },
    )
    this.layer = layer
    this.failedRefs = failedRefs
    this.landed = landed
    this.txHash = txHash
    this.mined = mined
  }
}

/**
 * Raised when a layer's `multiAttest` MINED SUCCESSFULLY (`status: 'success'`)
 * but its `Attested` logs could not be extracted (an RPC returning incomplete
 * logs, or event drift) — every attestation in this layer therefore EXISTS
 * on-chain, with UNKNOWN UIDs. This is NOT a revert ({@link WriteRevertedError}:
 * `failedRefs` did not mint) and NOT an unsent layer ({@link WriteNotSentError}):
 * resending this layer — or retrying the whole write — would DUPLICATE every
 * attestation in it. Recovery re-reads the transaction's receipt logs (another
 * RPC works) to recover the UIDs. Later layers were NOT sent (their symbolic
 * refs needed these UIDs).
 */
export class WriteUidsUnknownError extends EfsError {
  /** See {@link WriteRevertedError.storage} — same attachment, same recovery. */
  storage?: CompletedOnchainStorage
  override name = 'WriteUidsUnknownError'
  /** The DAG layer that mined with unextractable logs. */
  readonly layer: number
  /** The refs in the mined layer — every one EXISTS on-chain (UID unknown). */
  readonly mintedRefs: readonly string[]
  /** The `ref → UID` table from layers that landed BEFORE this one. */
  readonly landed: RefMap
  /** The MINED tx — the recovery handle (re-read its `Attested` logs). */
  readonly txHash: Hex
  constructor(
    layer: number,
    mintedRefs: readonly string[],
    landed: RefMap,
    txHash: Hex,
    cause: unknown,
  ) {
    const classified = classifyError(cause)
    super(
      `EFS write layer ${layer} MINED successfully (tx ${txHash}) but its Attested logs could not be extracted — all ${mintedRefs.length} attestation(s) in the layer (${mintedRefs.join(', ')}) EXIST on-chain with unknown UIDs. Do NOT resend the layer or retry the write (either would duplicate them); recover the UIDs from the tx's receipt logs. ${landed.size} attestation(s) from earlier layers already landed; later layers were not sent.`,
      { code: 'PartialBatchFailure', cause, details: classified.shortMessage },
    )
    this.layer = layer
    this.mintedRefs = mintedRefs
    this.landed = landed
    this.txHash = txHash
  }
}

/**
 * Raised when a layer's `multiAttest` was NEVER SENT — the `writeContract` call
 * itself threw (user rejection, wallet/RPC error, or a client-side preflight/
 * simulation failure) before any transaction was broadcast. So NO tx hash exists
 * and THIS layer has no in-flight tx to duplicate — but that alone does NOT make
 * a whole-write retry safe: `fs.write` does not resume, so when earlier layers
 * ({@link WriteNotSentError.landed}) or completed storage (`storage`) exist, a
 * retry rebuilds the write from scratch — re-minting the landed attestations,
 * re-paying storage deploys, and possibly reverting on permanent duplicate
 * anchors. Only with an empty `landed` AND no `storage` is a plain retry safe.
 *
 * The partial-write boundary from PRIOR layers is preserved: layers before
 * {@link WriteNotSentError.layer} already mined (their UIDs are in
 * {@link WriteNotSentError.landed}). The no-txHash counterpart of
 * {@link WriteRevertedError} (which carries an in-flight `txHash`).
 */
export class WriteNotSentError extends EfsError {
  /** See {@link WriteRevertedError.storage} — same attachment, same recovery. */
  storage?: CompletedOnchainStorage
  override name = 'WriteNotSentError'
  /** The DAG layer whose `multiAttest` was never sent. */
  readonly layer: number
  /** The refs that were in the un-sent layer (none of which minted). */
  readonly failedRefs: readonly string[]
  /** The `ref → UID` table from layers that *did* land before this attempt. */
  readonly landed: RefMap
  constructor(layer: number, failedRefs: readonly string[], landed: RefMap, cause: unknown) {
    const classified = classifyError(cause)
    const guidance =
      landed.size === 0
        ? `No earlier EAS layer landed. If no completed storage is attached ('storage'), nothing from this attempt is on-chain and a retry is safe; with 'storage' attached, pass storage.web3Uri as an explicit mirror on the retry instead of re-paying the deploy.`
        : `${landed.size} attestation(s) from earlier layers ALREADY LANDED and fs.write does not resume — a whole-write retry would re-mint them (and can revert on permanent duplicate anchors). Recover from 'landed' (and 'storage', when attached) instead of retrying.`
    super(
      `EFS write could not be sent at layer ${layer} — the transaction was never broadcast (${failedRefs.length} attestation(s): ${failedRefs.join(', ')}). No tx is in flight for this layer. ${guidance}`,
      { code: 'PartialBatchFailure', cause, details: classified.shortMessage },
    )
    this.layer = layer
    this.failedRefs = failedRefs
    this.landed = landed
  }
}

/**
 * Raised when a layer's `eth_sendTransaction` failed WITHOUT a response — the
 * transport dropped (connection loss / timeout) after the request may already
 * have reached the node — so whether the tx was broadcast is UNKNOWN: it may
 * still mine, and there is NO hash to reconcile by. Distinct from
 * {@link WriteNotSentError} (a refusal RESPONSE proves nothing was broadcast)
 * and {@link WriteRevertedError} (a hash exists). A blind retry can duplicate
 * the layer's attestations or revert on permanent duplicate anchors — check
 * the signing account's pending txs/nonce (or the layer's `Attested` events)
 * before retrying.
 */
export class WriteSendUnknownError extends EfsError {
  /** See {@link WriteRevertedError.storage} — same attachment, same recovery. */
  storage?: CompletedOnchainStorage
  override name = 'WriteSendUnknownError'
  /** The DAG layer whose send outcome is unknown. */
  readonly layer: number
  /** The refs in that layer — possibly minted, possibly not. */
  readonly refs: readonly string[]
  /** The `ref → UID` table from layers that landed BEFORE this one. */
  readonly landed: RefMap
  constructor(layer: number, refs: readonly string[], landed: RefMap, cause: unknown) {
    const classified = classifyError(cause)
    super(
      `EFS write layer ${layer}: the send failed WITHOUT a response — the transport dropped, so whether the transaction was broadcast is UNKNOWN and it MAY still mine (${refs.length} attestation(s): ${refs.join(', ')}; no tx hash is available). Do NOT blindly retry — a broadcast layer would be duplicated (or revert on permanent duplicate anchors); check the signing account's pending transactions/nonce or the layer's Attested events first. ${landed.size} attestation(s) from earlier layers already landed.`,
      { code: 'PartialBatchFailure', cause, details: classified.shortMessage },
    )
    this.layer = layer
    this.refs = refs
    this.landed = landed
  }
}

/** The r3741157003 gate: verify a hardlink plan's DATA is authored by the
 * submitting account BEFORE any layer broadcasts. Fails CLOSED when the
 * context cannot resolve a signing account or lacks `readContract` — a
 * foreign hardlink yields a visible-but-unreadable file (lens-scoped reads key
 * mirrors/properties on the placement attester), so the check is mandatory. */
async function assertHardlinkSelfAuthored(plan: FileWriteGraph, ctx: SubmitContext): Promise<void> {
  if (!plan.hardlink) return
  const pin = plan.attestations.find((a) => a.ref === REF.PLACEMENT_PIN)
  const dataUID = pin !== undefined && typeof pin.refUID === 'string' ? pin.refUID : undefined
  if (dataUID === undefined) return // a hardlink plan always carries a concrete PIN refUID
  const ctxAccount =
    typeof ctx.account === 'string'
      ? (ctx.account as Address)
      : (ctx.account as { address?: Address } | undefined)?.address
  const walletAccount = (ctx.walletClient as { account?: { address?: Address } }).account?.address
  const submitter = ctxAccount ?? walletAccount
  if (submitter === undefined) {
    throw new EfsError(
      'EFS write: a HARDLINK plan requires a resolvable signing account (ctx.account, or a wallet client with a bound account) — the self-authorship gate must verify the DATA author before placement.',
      { code: 'InvalidArgument' },
    )
  }
  if (ctx.publicClient.readContract === undefined) {
    throw new EfsError(
      'EFS write: a HARDLINK plan requires a publicClient with readContract — the self-authorship gate reads the DATA attestation before placement.',
      { code: 'InvalidArgument' },
    )
  }
  const att = (await ctx.publicClient.readContract({
    address: ctx.easAddress,
    abi: getAttestationAbi,
    functionName: 'getAttestation',
    args: [dataUID],
  })) as { attester?: Address; schema?: Hex } | undefined
  const author = att?.attester
  if (author === undefined || author.toLowerCase() !== submitter.toLowerCase()) {
    throw new EfsError(
      `EFS write: the hardlink DATA ${dataUID} is authored by ${author ?? '0x0 (unknown UID)'}, not the submitting account ${submitter}. A foreign hardlink resolves to a file whose mirrors/properties are INVISIBLE under your lens (unreadable, unverifiable). Re-publish the bytes as your own write instead. (Solidity parity: EFSLib.ForeignDataUID.)`,
      { code: 'InvalidArgument' },
    )
  }
  // The target must BE a DATA (r3741189815): EdgeResolver indexes the PIN under
  // the TARGET's actual schema while file resolution reads the DATA slot, so a
  // self-authored ANCHOR/PROPERTY target would yield a confirmed receipt for a
  // file no SDK reader can find. The expected UID rides ON THE PLAN (the
  // builder stamps `dataSchemaUID` from its schema set) — a plan without the
  // stamp fails CLOSED. (Solidity parity: EFSLib.NotDataUID.)
  const expected = plan.dataSchemaUID
  if (expected === undefined) {
    throw new EfsError(
      'EFS write: this HARDLINK plan carries no dataSchemaUID stamp — rebuild it with buildFileWriteGraph (the gate must verify the target is a DATA attestation before placement).',
      { code: 'InvalidArgument' },
    )
  }
  const schema = att?.schema
  if (schema === undefined || schema.toLowerCase() !== expected.toLowerCase()) {
    throw new EfsError(
      `EFS write: the hardlink target ${dataUID} is not a DATA attestation (schema ${schema ?? 'unknown'}, expected ${expected}). The placement PIN would index under the target's actual schema while file resolution reads the DATA slot — a confirmed receipt for a file no reader can find. (Solidity parity: EFSLib.NotDataUID.)`,
      { code: 'InvalidArgument' },
    )
  }
}

// One PIN encoder, reused to re-encode `definition` once it's resolved. The PIN
// schema is `bytes32 definition` (EFS_SCHEMA_FIELDS.pin).
const pinEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)

/** Distinct DAG layers present in the plan, ascending (the submit order). */
function layersOf(plan: FileWriteGraph): number[] {
  const set = new Set<number>()
  for (const a of plan.attestations) set.add(a.layer)
  return [...set].sort((x, y) => x - y)
}

/**
 * Resolve a {@link RefOrUID} (a concrete pre-existing UID or a {@link SymbolicRef})
 * to a concrete `Hex`, looking symbols up in the accumulated map.
 *
 * @throws EfsError if a symbol is unresolved — a programming/graph error (a
 *   forward/intra-layer reference the layer ordering should have prevented).
 */
function resolveRef(ref: RefOrUID, resolved: RefMap, context: string): Hex {
  if (!isSymbolicRef(ref)) return ref
  const uid = resolved.get(ref.ref)
  if (uid === undefined) {
    throw new EfsError(
      `Tier-1 submit: unresolved symbolic reference '${ref.ref}' while building ${context}. Its target was not minted in a prior layer — the write plan is malformed (a forward or intra-layer reference).`,
      { code: 'EfsError' },
    )
  }
  return uid
}

/**
 * Produce the concrete `(refUID, data)` for one planned attestation, substituting
 * any symbolic `refUID` and re-encoding the PIN `data` if its `definition` was a
 * symbol. Pure — does not touch the chain.
 */
function materialize(att: PlannedAttestation, resolved: RefMap): { refUID: Hex; data: Hex } {
  const refUID = resolveRef(att.refUID, resolved, `${att.kind} '${att.ref}' refUID`)

  // No in-data symbols → the encoded data is already final.
  if (att.dataRefs.length === 0) return { refUID, data: att.data }

  // The only in-data symbol the graph emits is a PIN's `definition` (bytes32). Re-
  // encode it with the resolved UID. We assert that here rather than generically
  // re-encoding every field, because the PIN schema is the only one with a fresh-
  // sibling in-data reference (graph.ts: PinDataRef.field is always 'definition').
  const definitionEntry = att.dataRefs.find((d) => d.field === 'definition')
  if (att.dataRefs.length !== 1 || definitionEntry === undefined) {
    throw new EfsError(
      `Tier-1 submit: ${att.kind} '${att.ref}' has unexpected in-data refs ${JSON.stringify(
        att.dataRefs.map((d) => d.field),
      )}; only a PIN 'definition' is supported.`,
      { code: 'EfsError' },
    )
  }
  const definition = resolveRef(
    definitionEntry.ref,
    resolved,
    `${att.kind} '${att.ref}' data.definition`,
  )
  return { refUID, data: pinEncoder.encodeData([definition]) }
}

/**
 * Group a layer's materialized attestations into `MultiAttestationRequest[]`
 * (one request per distinct schema, EAS's batching unit), while capturing the
 * **flat ref order** the requests will iterate in — this is the order EAS emits
 * `Attested` events, which the receipt parser zips against.
 *
 * Entries under one schema keep their relative input order; schemas appear in
 * first-seen order. Both are stable, so the flat ref array is the exact emission
 * order.
 */
function buildLayerRequests(
  atts: readonly PlannedAttestation[],
  resolved: RefMap,
): {
  requests: {
    schema: Hex
    data: {
      recipient: Address
      expirationTime: bigint
      revocable: boolean
      refUID: Hex
      data: Hex
      value: bigint
    }[]
  }[]
  flatRefs: string[]
} {
  // Preserve first-seen schema order for determinism.
  const order: Hex[] = []
  const bySchema = new Map<Hex, { refs: string[]; data: ReturnType<typeof materializedEntry>[] }>()

  for (const att of atts) {
    const { refUID, data } = materialize(att, resolved)
    let bucket = bySchema.get(att.schema)
    if (bucket === undefined) {
      bucket = { refs: [], data: [] }
      bySchema.set(att.schema, bucket)
      order.push(att.schema)
    }
    bucket.refs.push(att.ref)
    bucket.data.push(
      materializedEntry({
        revocable: att.revocable,
        refUID,
        data,
        ...(att.recipient !== undefined ? { recipient: att.recipient } : {}),
      }),
    )
  }

  const requests = order.map((schema) => {
    const bucket = bySchema.get(schema)
    if (bucket === undefined) {
      // Unreachable — `order` is populated from the same map. Guard for the type.
      throw new EfsError('Tier-1 submit: internal schema bucket missing.', { code: 'EfsError' })
    }
    return { schema, data: bucket.data }
  })
  // Flat refs follow the same schema order, then within-schema input order — the
  // EAS emission order.
  const flatRefs = order.flatMap((schema) => bySchema.get(schema)?.refs ?? [])
  return { requests, flatRefs }
}

/** Build one normalized `AttestationRequestData` entry (value/expiry fixed per the
 * EFS write invariants — `0n`/`0n`). `recipient` is `0x0` for every EFS write EXCEPT
 * an ADDR-mode LIST_ENTRY (whose member address rides in `recipient`); the plan
 * carries it explicitly there, and it defaults to {@link ZERO_ADDRESS} otherwise. */
function materializedEntry(input: {
  revocable: boolean
  refUID: Hex
  data: Hex
  recipient?: Address
}) {
  return {
    recipient: input.recipient ?? (ZERO_ADDRESS as Address),
    expirationTime: 0n,
    revocable: input.revocable,
    refUID: input.refUID,
    data: input.data,
    value: 0n,
  }
}

/**
 * Parse the EAS `Attested` events out of a mined receipt and return the minted
 * UIDs **in emission (log) order**, filtered to the EAS contract.
 *
 * @throws EfsError if the parsed UID count does not match `expected` — the receipt
 *   is not the `multiAttest` we sent (a wrong tx, a reorg, or a co-emitting
 *   contract); refusing to guess is the safe failure.
 */
function extractMintedUIDs(
  receipt: TransactionReceipt,
  easAddress: Address,
  expected: number,
): Hex[] {
  const easLower = easAddress.toLowerCase()
  const logs = parseEventLogs({
    abi: easAbi,
    eventName: 'Attested',
    // Cast: viem types the receipt's logs as its own `Log[]`; that is exactly
    // what `parseEventLogs` consumes. The explicit type keeps the mock honest.
    logs: receipt.logs as Log[],
  })
  const uids = logs
    .filter((l) => l.address.toLowerCase() === easLower)
    .map((l) => l.args.uid as Hex)

  if (uids.length !== expected) {
    throw new EfsError(
      `Tier-1 submit: expected ${expected} 'Attested' event(s) from the EAS contract in tx ${receipt.transactionHash}, ` +
        `found ${uids.length}. The receipt does not match the submitted multiAttest.`,
      { code: 'EfsError' },
    )
  }
  return uids
}

/**
 * The mechanism-neutral result of running a layered `multiAttest` plan: every
 * created `ref → real UID`, the per-layer tx hashes, and the per-layer breakdown.
 * {@link submitWriteTier1} adds the file-write-specific `dataUID`/`placementPinUID`
 * projection on top; the edge/value writes ({@link submitLayeredTier1}) consume this
 * directly (they have no placement PIN).
 */
export interface LayeredWriteResult {
  /** Every created `ref → real UID`, across all layers. */
  readonly uids: RefMap
  /** Each layer's tx hash, in execution order. */
  readonly layerTxHashes: readonly Hex[]
  /** Per-layer breakdown (hash + minted refs), in execution order. */
  readonly layers: readonly LayerResult[]
}

/**
 * Execute ANY {@link FileWriteGraph}-shaped plan as one `multiAttest` per
 * dependency layer (Tier-1, any-wallet) — the mechanism-neutral core shared by the
 * file write ({@link submitWriteTier1}) and the standalone edge/value writes
 * (`writes/edge.ts`: TAG / PROPERTY-triple / PIN). See the module doc for the
 * layer/UID-threading model. Performs NO file-specific interpretation of the result
 * (no placement-PIN/DATA extraction) — it just runs the plan and returns the raw
 * `ref → UID` map.
 *
 * @param plan A layered write plan (every attestation carries its `layer`).
 * @param ctx  Wallet + public clients, the EAS address, and optional account/chain.
 * @returns A {@link LayeredWriteResult}: all created UIDs keyed by ref + per-layer hashes.
 * @throws {WriteRevertedError} on a layer revert — the partial-write boundary.
 */
export async function submitLayeredTier1(
  plan: FileWriteGraph,
  ctx: SubmitContext,
): Promise<LayeredWriteResult> {
  // HARDLINK plans reuse a pre-existing DATA — enforce the self-authorship +
  // DATA-schema gates HERE, the common boundary EVERY exported executor
  // funnels through (submitWriteTier1 wraps this; the edge verbs call it
  // directly), so no entry point can bypass them (r3741216400). Edge plans are
  // hardlink:false, so this is a no-op for them; the Solidity SDK applies the
  // same gates on-chain (ForeignDataUID / NotDataUID).
  await assertHardlinkSelfAuthored(plan, ctx)
  const resolved = new Map<string, Hex>()
  const layerTxHashes: Hex[] = []
  const layers: LayerResult[] = []

  for (const layer of layersOf(plan)) {
    const layerAtts = plan.attestations.filter((a) => a.layer === layer)
    if (layerAtts.length === 0) continue

    // Resolve symbols against prior layers' UIDs, group by schema, capture the
    // flat ref order EAS will emit in. (Pure — no tx; the abort + chain guards run just
    // before the broadcast below so a bail is a no-tx failure that still carries `flatRefs`.)
    const { requests, flatRefs } = buildLayerRequests(layerAtts, resolved)
    const call = buildMultiAttest(ctx.easAddress, requests)

    // Cancellation boundary: bail BEFORE sending this layer's irreversible multiAttest (never
    // mid-flight — a tx already broadcast can't be unsent). Once an earlier layer has landed
    // (`resolved.size > 0`), a mid-write abort is a PARTIAL write — fold it into the no-tx
    // WriteNotSentError (landed map + PartialBatchFailure, the AbortError as `cause`) so the
    // caller can recover. On the first/only layer (nothing landed) let the raw AbortError
    // escape (no partial write to describe). Mirrors the pre-send chain-guard handling below.
    if (ctx.signal?.aborted) {
      if (resolved.size === 0) ctx.signal.throwIfAborted()
      throw new WriteNotSentError(layer, flatRefs, new Map(resolved), ctx.signal.reason)
    }

    // Send the layer's single multiAttest. The five failure modes are kept
    // DISTINCT so a caller can tell what (if anything) landed:
    //
    //   (a) writeContract fails WITH a refusal response — a wallet/node error code, a
    //       decoded revert, or our pre-send chain guard → NO tx was broadcast: nothing
    //       landed in THIS layer → WriteNotSentError (no txHash), carrying the
    //       landed-UID map (whole-write retry safety depends on `landed`/`storage`).
    //   (a′) writeContract fails WITHOUT a response (transport drop/timeout — no
    //       JSON-RPC/EIP-1193 code anywhere in the chain) → broadcast state UNKNOWN,
    //       no hash to reconcile by → WriteSendUnknownError (may still mine).
    //   (b) the receipt wait throws after a txHash exists → the tx may still mine
    //       later: outcome UNKNOWN, naive retry risks a duplicate →
    //       WriteRevertedError(mined:false) carrying the in-flight txHash.
    //   (c) the receipt reports status:'reverted' → the tx mined and reverted →
    //       WriteRevertedError(mined:true) carrying the txHash.
    //   (d) the receipt is SUCCESS but the Attested logs can't be extracted → the
    //       layer's attestations EXIST with unknown UIDs → WriteUidsUnknownError
    //       (resending would duplicate them; recover from the receipt logs).
    //
    // All four preserve the prior-layer landed refs.
    // Wrong-chain boundary (pre-send): re-assert the live wallet/public chain BEFORE
    // broadcasting — a multi-layer write prompts once per layer, so a switch after an earlier
    // layer mined must not broadcast this dependent layer to the new chain. When earlier layers
    // already landed (`resolved.size > 0`), a drift here is a PARTIAL write: fold it into the
    // no-tx WriteNotSentError so the caller keeps the landed-UID map + PartialBatchFailure
    // context (the WrongChain rides as `cause`). When NOTHING has landed yet (first/only layer),
    // let WrongChain escape raw — there's no partial write to describe, and a bare WrongChain is
    // the honest signal (matches the standalone single-layer write contract).
    try {
      await ctx.assertChain?.()
    } catch (cause) {
      if (resolved.size === 0) throw cause
      throw new WriteNotSentError(layer, flatRefs, new Map(resolved), cause)
    }

    let txHash: Hex
    try {
      txHash = await ctx.walletClient.writeContract({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        value: call.value,
        ...(ctx.account !== undefined ? { account: ctx.account } : {}),
        ...(ctx.chain !== undefined ? { chain: ctx.chain } : {}),
      })
    } catch (cause) {
      // Split (a) from (a′) by whether the failure carries a RESPONSE
      // (r3740924421): a classified refusal proves the node/wallet ANSWERED —
      // nothing broadcast. A code-less transport failure proves nothing: the
      // request may have reached the node and the tx may still mine, so the
      // not-sent contract ("no tx exists, this layer is clean") must not be
      // asserted.
      if (isDefiniteSendRefusal(cause)) {
        throw new WriteNotSentError(layer, flatRefs, new Map(resolved), cause)
      }
      throw new WriteSendUnknownError(layer, flatRefs, new Map(resolved), cause)
    }

    let receipt: TransactionReceipt
    try {
      // The public client can drift to another chain AFTER the tx is broadcast and BEFORE
      // this wait; waiting on the wrong chain would surface a tx that is mining on the
      // deployment chain as not-found (a FALSE mined:false / partial failure). Re-assert
      // INSIDE the try so a drift is reported as the honest (b) outcome — "may still mine,
      // here's the in-flight txHash" — not a misleading revert, and recovery keeps the hash.
      await ctx.assertChain?.()
      receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (cause) {
      // (b) Tx sent, receipt unknown — may still mine; carry the txHash, mined:false.
      throw new WriteRevertedError(layer, flatRefs, new Map(resolved), txHash, false, cause)
    }

    // (c) A mined-but-reverted tx yields a receipt with `status: 'reverted'`.
    if (receipt.status === 'reverted') {
      throw new WriteRevertedError(
        layer,
        flatRefs,
        new Map(resolved),
        txHash,
        true,
        new EfsError(`multiAttest reverted on-chain (tx ${txHash}).`, {
          code: 'ContractReverted',
        }),
      )
    }

    // EAS emits one Attested per attestation, in submission order — zip against
    // the captured flat ref order.
    let uids: readonly Hex[]
    try {
      uids = extractMintedUIDs(receipt, ctx.easAddress, flatRefs.length)
    } catch (cause) {
      // The layer MINED (status success) — only the Attested-log extraction
      // failed (an RPC returning incomplete logs, or event drift). This is
      // mode (d): NOT a revert (WriteRevertedError's contract says failedRefs
      // did not mint — here every ref DID), and NOT unsent. The distinct class
      // makes the duplicate-on-resend hazard structural: recovery re-reads the
      // tx's logs instead of replaying the layer.
      throw new WriteUidsUnknownError(layer, flatRefs, new Map(resolved), txHash, cause)
    }
    const minted: { ref: string; uid: Hex }[] = flatRefs.map((ref, i) => {
      // `extractMintedUIDs` asserts `uids.length === flatRefs.length`, so the
      // index is always in range — the `?? ZERO_UID` only satisfies the
      // noUncheckedIndexedAccess type gate and is never taken.
      const u = uids[i] ?? ZERO_UID
      resolved.set(ref, u)
      return { ref, uid: u }
    })

    layerTxHashes.push(txHash)
    const result: LayerResult = { layer, txHash, minted }
    layers.push(result)
    // The progress hook is best-effort UI/reporting. A throw here — AFTER this layer mined —
    // must NOT propagate and abort the remaining (irreversible, dependent) layers: that would
    // manufacture a partial write from reporting code, with none of the structured
    // partial-write error a real tx failure carries. Cancellation has its own AbortSignal
    // (checked before each send); a callback bug is swallowed so it can't corrupt the write.
    try {
      ctx.onLayer?.(result)
    } catch {
      // best-effort progress only — a reporting-callback exception never interrupts the write
    }
  }

  return { uids: resolved, layerTxHashes, layers }
}

/**
 * Execute a {@link FileWriteGraph} **file-write** plan as one `multiAttest` per
 * dependency layer (Tier-1, any-wallet) and project the file-specific result
 * (DATA + placement-PIN UIDs). Thin wrapper over {@link submitLayeredTier1}.
 *
 * @param plan The ordered file-write plan from `buildFileWriteGraph`.
 * @param ctx  Wallet + public clients, the EAS address, and optional account/chain.
 * @returns A {@link Tier1WriteResult}: all created UIDs keyed by ref, the per-layer
 *   tx hashes, and the file's DATA + placement-PIN UIDs.
 * @throws {WriteRevertedError} on a layer revert — the partial-write boundary,
 *   carrying which layer failed and what landed before it.
 */
export async function submitWriteTier1(
  plan: FileWriteGraph,
  ctx: SubmitContext,
): Promise<Tier1WriteResult> {
  // The hardlink authorship/schema gates run inside submitLayeredTier1 — the
  // common boundary every exported executor funnels through (r3741216400).
  const { uids: resolved, layerTxHashes, layers } = await submitLayeredTier1(plan, ctx)

  const placementPinUID = resolved.get(REF.PLACEMENT_PIN)
  if (placementPinUID === undefined) {
    // Every file-write plan (fresh or hardlink) ends in a placement PIN; its
    // absence means an empty/malformed plan reached the submitter.
    throw new EfsError(
      'Tier-1 submit: plan produced no placement PIN — nothing was placed. The write plan is empty or malformed.',
      { code: 'EfsError' },
    )
  }

  // DATA is re-minted only for a fresh write; a hardlink reuses a pre-existing
  // DATA UID (carried in the plan's PIN refUID), so it is absent from `resolved`.
  const dataUID = resolved.get(REF.DATA)

  return {
    uids: resolved,
    layerTxHashes,
    layers,
    dataUID,
    placementPinUID,
  }
}
