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
import {
  ParentNotFoundError,
  type ResolvePublicClient,
  type TagReadPublicClient,
  planExistingAncestorVisibilityTags,
  resolveOrPlanParents,
  splitPath,
} from '../reads/resolve.js'
import type { DataRef, DataUID, WriteOptions, WriteReceipt } from '../types.js'
import { buildFileWriteGraph } from './graph.js'
import {
  DEFAULT_ONCHAIN_AUTO_LIMIT,
  type OnchainPublicClient,
  type OnchainWalletClient,
  PayloadTooLarge,
  storeOnchain,
} from './onchain.js'
import {
  type SubmitPublicClient,
  type SubmitWalletClient,
  type Tier1WriteResult,
  submitWriteTier1,
} from './submit.js'

/** Extract the URI scheme (`ipfs` from `ipfs://Qm…`, `web3` from `web3://0x…`). */
function schemeOf(uri: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(uri)
  return m?.[1] !== undefined ? m[1].toLowerCase() : ''
}

/**
 * Look up the `/transports/<scheme>` anchor UID for a mirror's scheme: an explicit
 * `opts.transportDefinition` wins, else the deployment's `transports` map.
 *
 * @throws {EfsError} `MissingTransport` when neither source has one.
 */
function transportDefinitionFor(
  scheme: string,
  deployment: EfsDeployment,
  opts: WriteOptions | undefined,
): Hex {
  const transportDefinition = opts?.transportDefinition ?? deployment.transports?.[scheme]
  if (transportDefinition === undefined) {
    throw new EfsError(
      `EFS write: no transport definition for scheme '${scheme}'. Pass \`opts.transportDefinition\` (the on-chain /transports/${scheme} anchor UID), or use a deployment whose \`transports\` map records it (the deploy seeds these).`,
      { code: 'MissingTransport' },
    )
  }
  return transportDefinition
}

/**
 * Decide the file's mirrors + transport-definition anchor UID, storing on-chain
 * when that is the resolved path. Three branches:
 *
 *  1. Caller-supplied `opts.mirrors` → used verbatim (bytes live there; no storage
 *     happens). Transport from `opts.transportDefinition`, else the deployment map
 *     keyed by the FIRST mirror's scheme.
 *  2. No mirrors, `{ storage: 'onchain' }` OR within the on-chain auto-cap →
 *     deploy the bytes on-chain (SSTORE2 chunk + manager) and publish the
 *     `web3://<manager>` URI as the mirror, with the `web3` (`/transports/onchain`)
 *     transport anchor. The cap is bypassed when `storage:'onchain'` is set.
 *  3. No mirrors, over the cap, no override → throw {@link PayloadTooLarge}.
 *
 * @throws {EfsError} `MissingTransport` when no transport-definition anchor exists.
 * @throws {PayloadTooLarge} no mirrors + over the auto-cap + no `storage` override.
 * @throws {MultiChunkUnsupported} on-chain payload exceeds one SSTORE2 chunk.
 */
export async function resolveMirrors(
  bytes: Uint8Array,
  ctx: FileWriteContext,
  opts: WriteOptions | undefined,
): Promise<{ mirrors: string[]; transportDefinition: Hex }> {
  const { deployment } = ctx

  // 1. Caller supplied where the bytes live → use those mirrors (no storage).
  const first = opts?.mirrors?.[0]
  if (opts?.mirrors !== undefined && first !== undefined) {
    return {
      mirrors: [...opts.mirrors],
      transportDefinition: transportDefinitionFor(schemeOf(first), deployment, opts),
    }
  }

  // 2/3. No mirrors → on-chain SSTORE2 storage (the zero-infra default). Forced by
  // `storage:'onchain'` (cap bypassed), else gated by the on-chain auto-cap.
  const forced = opts?.storage === 'onchain'
  const limit = ctx.onchainAutoLimit ?? DEFAULT_ONCHAIN_AUTO_LIMIT
  if (!forced && bytes.byteLength > limit) {
    throw new PayloadTooLarge(bytes.byteLength, limit)
  }

  // The web3:// mirror's transport is the `web3` scheme (the /transports/onchain
  // anchor). Resolve it first (a missing one throws MissingTransport before any
  // deploy); `storeOnchain` then deploys and throws MultiChunkUnsupported for an
  // over-one-chunk payload (only reachable via the `storage:'onchain'` cap bypass).
  const transportDefinition = transportDefinitionFor(TRANSPORT.web3, deployment, opts)
  const { web3Uri } = await storeOnchain(bytes, {
    walletClient: ctx.walletClient,
    publicClient: ctx.publicClient,
    ...(ctx.account !== undefined ? { account: ctx.account } : {}),
    ...(ctx.chain !== undefined ? { chain: ctx.chain } : {}),
  })
  return { mirrors: [web3Uri], transportDefinition }
}

/** The viem clients + deployment context the file-write orchestrator needs. */
export interface FileWriteContext {
  readonly publicClient: ResolvePublicClient &
    TagReadPublicClient &
    SubmitPublicClient &
    OnchainPublicClient
  readonly walletClient: SubmitWalletClient & OnchainWalletClient
  readonly deployment: EfsDeployment
  /** The signing account (forwarded to the submitter's `writeContract`). */
  readonly account?: Address | Account
  /** The chain to assert against (forwarded to the submitter). */
  readonly chain?: Chain
  /**
   * Client-level cap (bytes) for the no-mirrors AUTO on-chain store
   * (`write.onchainAutoLimit`). Omitted ⇒ {@link DEFAULT_ONCHAIN_AUTO_LIMIT}
   * (16 KB). A per-call `{ storage: 'onchain' }` bypasses it.
   */
  readonly onchainAutoLimit?: number
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
 * @throws {ParentNotFoundError} the parent folder does not exist and
 *   `opts.createParents` is explicitly `false`. By default (`createParents` unset or
 *   `true`) the missing ancestor folders are created in the same write (mkdir -p).
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

  // 2. Plan the parent folder chain (resolve as deep as it exists) + the file name.
  // Done BEFORE storage so a missing-parent write fails fast — never deploying
  // on-chain chunks for a path that can't be placed. When parents are missing the
  // behavior splits on `createParents`: by default fold the missing folders into the
  // same write (mkdir -p); only `createParents: false` throws `ParentNotFoundError`.
  const parentPlan = await resolveOrPlanParents(
    ctx.publicClient,
    deployment.contracts.indexer,
    path,
  )
  const { fileName, existingAncestorUIDs } = parentPlan
  // The anchor the file-ANCHOR hangs off of: the resolved parent (no gap) or, when
  // creating ancestors, the deepest existing anchor the created chain extends from.
  let parentAnchorUID: Hex
  let missingParents: readonly string[] = []
  if ('parentAnchorUID' in parentPlan) {
    parentAnchorUID = parentPlan.parentAnchorUID
  } else if (opts?.createParents !== false) {
    parentAnchorUID = parentPlan.deepestExistingAnchorUID
    missingParents = parentPlan.missingSegments
  } else {
    // Reconstruct the resolved/missing split for a precise error: the missing
    // suffix is `parentPlan.missingSegments` (shallowest-first); everything before
    // it resolved. The first missing segment is the one that broke the walk.
    const parentSegments = splitPath(path).slice(0, -1)
    const resolvedSegments = parentSegments.slice(
      0,
      parentSegments.length - parentPlan.missingSegments.length,
    )
    throw new ParentNotFoundError(path, resolvedSegments, parentPlan.missingSegments[0] as string)
  }

  // 3. Mirror + transport-definition. With no caller `mirrors` this STORES the
  // bytes on-chain (SSTORE2) and yields a web3:// mirror — the zero-infra default.
  const { mirrors, transportDefinition } = await resolveMirrors(content, ctx, opts)

  // 3a. Folder-visibility TAGs (overview.md "Upload flow" step 7; ADR-0038/0041).
  // Walk the EXISTING ancestors bottom-up and find the ones the uploader hasn't
  // tagged yet (short-circuiting at the first already-tagged ancestor). The
  // freshly-created `missingParents` folders always need a TAG and are derived
  // inside the graph builder, so they are NOT walked here. The attester is the
  // connected account — its lens listing is what these TAGs make the folders visible
  // in.
  const attester = accountAddress(ctx.account)
  const existingAncestorTagUIDs = await planExistingAncestorVisibilityTags(
    ctx.publicClient,
    existingAncestorUIDs,
    {
      edgeResolver: deployment.contracts.edgeResolver,
      attester,
      dataSchemaUID: deployment.schemas.data,
      anchorSchemaUID: deployment.schemas.anchor,
    },
  )

  // 4. Build the pure write plan (the 9-schema, layered attestation DAG).
  const plan = buildFileWriteGraph({
    path,
    content: { kind: 'bytes', bytes: content },
    mirrors,
    ...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
    // ADR-0006: the `contentHash` PROPERTY value is the BARE SHA-256 digest
    // (lowercase 64-hex, NO `0x` prefix) — byte-identical to `sha256sum`. The read
    // path (`verifyContent` / `statusFor`) validates exactly this canonical form,
    // so prefixing `0x` here would store a 66-char value that reads back as
    // `malformed-claim`. `hashContent` already returns the bare digest.
    contentHash,
    size,
    schemas: deployment.schemas,
    transportDefinition,
    parentAnchorUID,
    ...(missingParents.length > 0 ? { missingParents } : {}),
    ...(existingAncestorTagUIDs.length > 0 ? { existingAncestorTagUIDs } : {}),
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
  // key on it, computed in step 3a); `opts.lens` is reserved but not yet honored on
  // Tier-1.
  return toReceipt(result, contentHash, deployment.chainId, attester)
}

/** The address of a viem account-or-address (the attester the receipt records). */
function accountAddress(account: Address | Account | undefined): Address {
  if (account === undefined) return '0x0000000000000000000000000000000000000000'
  return typeof account === 'string' ? account : account.address
}
