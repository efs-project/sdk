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
import { easAbi } from '../eas/abi.js'
import { buildMultiAttest } from '../eas/attest.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'
import { EfsError, classifyError } from '../errors.js'
import {
  type FileWriteGraph,
  type PlannedAttestation,
  REF,
  type RefOrUID,
  ZERO_ADDRESS,
  ZERO_UID,
  isSymbolicRef,
} from './graph.js'

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
 * Raised when a layer's `multiAttest` reverts. The partial-write boundary: layers
 * before {@link WriteRevertedError.layer} already mined (their UIDs are in
 * {@link WriteRevertedError.landed}); this layer and all later ones did not. The
 * file is half-written — the caller decides whether to resume or revoke.
 */
export class WriteRevertedError extends EfsError {
  override name = 'WriteRevertedError'
  /** The DAG layer whose `multiAttest` reverted. */
  readonly layer: number
  /** The refs that were in the reverted layer (none of which minted). */
  readonly failedRefs: readonly string[]
  /** The `ref → UID` table from layers that *did* land before the revert. */
  readonly landed: RefMap
  constructor(layer: number, failedRefs: readonly string[], landed: RefMap, cause: unknown) {
    const classified = classifyError(cause)
    super(
      `EFS write reverted at layer ${layer} (${failedRefs.length} attestation(s): ${failedRefs.join(', ')}). ` +
        `${landed.size} attestation(s) from earlier layers already landed — the file is partially written.`,
      { code: 'PartialBatchFailure', cause, details: classified.shortMessage },
    )
    this.layer = layer
    this.failedRefs = failedRefs
    this.landed = landed
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
    bucket.data.push(materializedEntry({ revocable: att.revocable, refUID, data }))
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

/** Build one normalized `AttestationRequestData` entry (recipient/value/expiry
 * fixed per the EFS write invariants — `0x0`/`0n`/`0n`). */
function materializedEntry(input: { revocable: boolean; refUID: Hex; data: Hex }) {
  return {
    recipient: ZERO_ADDRESS as Address,
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
 * Execute a {@link FileWriteGraph} write plan as one `multiAttest` per dependency
 * layer (Tier-1, any-wallet). See the module doc for the full model.
 *
 * @param plan The ordered write plan from `buildFileWriteGraph`.
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
  const resolved = new Map<string, Hex>()
  const layerTxHashes: Hex[] = []
  const layers: LayerResult[] = []

  for (const layer of layersOf(plan)) {
    const layerAtts = plan.attestations.filter((a) => a.layer === layer)
    if (layerAtts.length === 0) continue

    // Resolve symbols against prior layers' UIDs, group by schema, capture the
    // flat ref order EAS will emit in.
    const { requests, flatRefs } = buildLayerRequests(layerAtts, resolved)
    const call = buildMultiAttest(ctx.easAddress, requests)

    // Send the layer's single multiAttest. A revert here (resolver `revert`/EAS
    // error) is the partial-write boundary — wrap it with the landed UIDs.
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
      throw new WriteRevertedError(layer, flatRefs, new Map(resolved), cause)
    }

    let receipt: TransactionReceipt
    try {
      receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (cause) {
      throw new WriteRevertedError(layer, flatRefs, new Map(resolved), cause)
    }

    // A mined-but-reverted tx still yields a receipt with `status: 'reverted'`.
    // Treat that as the same partial-write boundary as a thrown revert.
    if (receipt.status === 'reverted') {
      throw new WriteRevertedError(
        layer,
        flatRefs,
        new Map(resolved),
        new EfsError(`multiAttest reverted on-chain (tx ${txHash}).`, {
          code: 'ContractReverted',
        }),
      )
    }

    // EAS emits one Attested per attestation, in submission order — zip against
    // the captured flat ref order.
    const uids = extractMintedUIDs(receipt, ctx.easAddress, flatRefs.length)
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
    ctx.onLayer?.(result)
  }

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
