/**
 * The `efs.fs.write` orchestrator for the **Tier-1 (any-wallet, multi-signature)**
 * path — it composes the pieces the pure builder + submitter expose into one
 * "save this file" call:
 *
 *   hashContent → resolve mirror/transport → resolve parent anchor →
 *   buildFileWriteGraph → submitWriteTier1 → map to the public WriteReceipt.
 *
 * It performs the chain reads/writes (parent resolution + per-layer multiAttest)
 * but stays decoupled from the client surface: it takes the viem clients + the
 * resolved deployment as plain inputs, so it is unit-testable with mocked clients
 * (test/file-write.test.ts) exactly like the submitter is.
 *
 * NOTE — tiers: this is **Tier 1**. The Tier-2 (one-signature) path — batching the
 * whole DAG into a single user signature via EIP-7702 batched-auth / EIP-5792
 * `wallet_sendCalls`, threading UIDs in-memory through the `@efs/solidity` routine
 * — is a later slice. Both tiers consume the *same* `buildFileWriteGraph` plan;
 * they differ only in the submit strategy. This orchestrator hard-wires the Tier-1
 * submitter (`submitWriteTier1`).
 */

import type { Account, Address, Chain, Hex } from 'viem'
import type { EfsDeployment } from '../chain/deployments.js'
import { type ContentHash, hashContent } from '../content/hash.js'
import { EfsError } from '../errors.js'
import { TRANSPORT } from '../mirror/transport.js'
import { type ResolvePublicClient, resolveParentAnchor } from '../reads/resolve.js'
import type { DataRef, DataUID, WriteOptions, WriteReceipt } from '../types.js'
import { buildFileWriteGraph } from './graph.js'
import {
  type SubmitPublicClient,
  type SubmitWalletClient,
  type Tier1WriteResult,
  submitWriteTier1,
} from './submit.js'

/**
 * Default cap on inline (`data:`) content. Above this, the caller MUST supply
 * `opts.mirrors` — a multi-kilobyte payload encoded into the MIRROR `uri` field
 * (and re-encoded across signatures) is pathological on-chain. 8 KiB mirrors the
 * MirrorResolver `MAX_URI_LENGTH` (ADR-0022); the base64 `data:` envelope is
 * larger than the raw bytes, so we cap the *raw* bytes well under it.
 */
export const MAX_INLINE_BYTES = 4 * 1024

/** Bytes → a base64 `data:` URI. Self-contained retrieval needing no network —
 * the inline-fallback mirror when the caller supplies no `opts.mirrors`. */
function toDataUri(bytes: Uint8Array, contentType: string | undefined): string {
  // btoa over a binary string. Build the binary string in chunks to avoid a giant
  // spread (apply arg-count limits) on large inputs — capped at MAX_INLINE_BYTES
  // anyway, so this stays small.
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const b64 = btoa(binary)
  const media = contentType ?? 'application/octet-stream'
  return `data:${media};base64,${b64}`
}

/** Extract the URI scheme (`ipfs` from `ipfs://Qm…`, `data` from `data:…`). */
function schemeOf(uri: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(uri)
  return m?.[1] !== undefined ? m[1].toLowerCase() : ''
}

/**
 * Decide the file's mirrors and the transport-definition anchor UID for them.
 *
 * - Caller-supplied `opts.mirrors` are used verbatim (the bytes live there). The
 *   transport definition comes from `opts.transportDefinition`, else the
 *   deployment's `transports` map keyed by the FIRST mirror's scheme.
 * - No mirrors → fall back to a single inline `data:` URI (guarded by
 *   {@link MAX_INLINE_BYTES}); its transport definition is the `data` transport.
 *
 * @throws {EfsError} `MissingTransport` when no transport-definition anchor can be
 *   determined (the deploy seeds these; name what's missing).
 * @throws {EfsError} `InvalidArgument` when content exceeds the inline cap and no
 *   mirrors were supplied.
 */
export function resolveMirrors(
  bytes: Uint8Array,
  deployment: EfsDeployment,
  opts: WriteOptions | undefined,
): { mirrors: string[]; transportDefinition: Hex } {
  const transports = deployment.transports ?? {}

  // Caller supplied where the bytes live → use those mirrors.
  const first = opts?.mirrors?.[0]
  if (opts?.mirrors !== undefined && first !== undefined) {
    const mirrors = [...opts.mirrors]
    const scheme = schemeOf(first)
    const transportDefinition = opts.transportDefinition ?? transports[scheme]
    if (transportDefinition === undefined) {
      throw new EfsError(
        `EFS write: no transport definition for scheme '${scheme}'. Pass \`opts.transportDefinition\` (the on-chain /transports/${scheme} anchor UID), or use a deployment whose \`transports\` map records it (the deploy seeds these).`,
        { code: 'MissingTransport' },
      )
    }
    return { mirrors, transportDefinition }
  }

  // No mirrors → inline data: fallback (size-capped).
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new EfsError(
      `EFS write: content is ${bytes.byteLength} bytes, over the ${MAX_INLINE_BYTES}-byte inline cap. Supply \`opts.mirrors\` (URIs where the bytes are hosted) for content this large.`,
      { code: 'InvalidArgument' },
    )
  }
  const transportDefinition = opts?.transportDefinition ?? transports[TRANSPORT.data]
  if (transportDefinition === undefined) {
    throw new EfsError(
      `EFS write: no transport definition for the inline 'data' scheme. Pass \`opts.transportDefinition\` (the on-chain /transports/data anchor UID) or supply \`opts.mirrors\`; the deploy seeds the transports map.`,
      { code: 'MissingTransport' },
    )
  }
  return { mirrors: [toDataUri(bytes, opts?.contentType)], transportDefinition }
}

/** The viem clients + deployment context the file-write orchestrator needs. */
export interface FileWriteContext {
  readonly publicClient: ResolvePublicClient & SubmitPublicClient
  readonly walletClient: SubmitWalletClient
  readonly deployment: EfsDeployment
  /** The signing account (forwarded to the submitter's `writeContract`). */
  readonly account?: Address | Account
  /** The chain to assert against (forwarded to the submitter). */
  readonly chain?: Chain
}

/**
 * Map a {@link Tier1WriteResult} to the public {@link WriteReceipt}. The receipt's
 * `data` ref points at the file's content-identity DATA UID, resolved by the
 * attester; `steps` records every minted attestation (ref → UID, all `done`).
 */
function toReceipt(
  result: Tier1WriteResult,
  contentHash: ContentHash,
  chainId: number,
  attester: Address,
): WriteReceipt {
  // DATA is the static content ref; for a hardlink it pre-existed and the
  // submitter returns `dataUID: undefined`, so there is no fresh DATA to ref.
  const data: DataRef | undefined =
    result.dataUID !== undefined
      ? {
          __brand: 'DataRef',
          uid: result.dataUID as DataUID,
          chainId,
          resolvedBy: attester,
        }
      : undefined

  const steps = [...result.uids.entries()].map(([id, uid]) => ({
    id,
    uid: uid as DataUID,
    done: true,
  }))

  return {
    contentHash,
    ...(data !== undefined ? { data } : {}),
    steps,
    signatureCount: result.layerTxHashes.length,
    mechanism: 'sequential',
    status: 'confirmed',
  }
}

/**
 * Execute a Tier-1 file write end to end. See the module doc for the pipeline.
 *
 * @throws {ParentNotFoundError} the parent folder does not exist (require it for
 *   now; mkdir-p is a later slice).
 * @throws {EfsError} `MissingTransport` / `InvalidArgument` from mirror resolution.
 * @throws {WriteRevertedError} a layer's multiAttest reverted (partial-write
 *   boundary) — surfaced verbatim to the caller.
 */
export async function writeFileTier1(
  path: string,
  content: Uint8Array,
  ctx: FileWriteContext,
  opts?: WriteOptions,
): Promise<WriteReceipt> {
  const { deployment } = ctx

  // 1. Content identity (ADR-0006: bare SHA-256) + size.
  const contentHash = hashContent(content)
  const size = BigInt(content.byteLength)

  // 2. Mirror + transport-definition (caller mirrors, else inline data:).
  const { mirrors, transportDefinition } = resolveMirrors(content, deployment, opts)

  // 3. Resolve the parent folder anchor (require it to exist) + the file name.
  const { parentAnchorUID, fileName } = await resolveParentAnchor(
    ctx.publicClient,
    deployment.contracts.indexer,
    path,
  )

  // 4. Build the pure write plan (the 9-schema, layered attestation DAG).
  const plan = buildFileWriteGraph({
    path,
    content: { kind: 'bytes', bytes: content },
    mirrors,
    ...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
    // `buildFileWriteGraph` wants the contentHash as 0x-hex; hashContent returns
    // a bare digest (ADR-0006), so prefix it for the PROPERTY value encoding.
    contentHash: `0x${contentHash}` as Hex,
    size,
    schemas: deployment.schemas,
    transportDefinition,
    parentAnchorUID,
    fileName,
  })

  // 5. Submit Tier-1: one multiAttest per DAG layer, threading mined UIDs.
  const result = await submitWriteTier1(plan, {
    walletClient: ctx.walletClient,
    publicClient: ctx.publicClient,
    easAddress: deployment.contracts.eas,
    ...(ctx.account !== undefined ? { account: ctx.account } : {}),
    ...(ctx.chain !== undefined ? { chain: ctx.chain } : {}),
  })

  // 6. Map to the public receipt. The attester is the connected account (lenses
  // key on it); `opts.lens` is reserved but not yet honored on Tier-1.
  const attester = accountAddress(ctx.account)
  return toReceipt(result, contentHash, deployment.chainId, attester)
}

/** The address of a viem account-or-address (the attester the receipt records). */
function accountAddress(account: Address | Account | undefined): Address {
  if (account === undefined) return '0x0000000000000000000000000000000000000000'
  return typeof account === 'string' ? account : account.address
}
