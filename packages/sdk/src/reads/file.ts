/**
 * Lens-scoped file resolution + reserved-key PROPERTY reads — the engine behind
 * `efs.fs.resolve`, `efs.fs.stat`, and the first half of `efs.fs.read`.
 *
 * ## How a path resolves to a DataRef (FROZEN contracts)
 *
 * 1. Walk the path to the **file's own anchor UID** — `resolvePathToAnchor` walks
 *    every segment INCLUDING the file name (a file is an Anchor whose children are
 *    its placements). An empty slot at any segment ⇒ the file does not exist.
 * 2. Read the winning placement with `EFSFileView.getFilesAtPath(fileAnchorUID,
 *    attesters, DATA_SCHEMA_UID, cursor, maxItems)` (EFSFileView.sol:805). It walks
 *    the attester list first-wins, reads the active PIN's DATA target per attester
 *    (`getActivePinTarget`, revoked excluded), dedups across attesters, and returns
 *    `FileSystemItem`s whose `.uid` is the DATA UID and whose `.attester` is the
 *    **placement (lens) attester that won** — NOT the DATA author. That winning
 *    attester is `resolvedBy`: the address we scope MIRROR + PROPERTY reads to and
 *    verify `contentHash` against (ADR-0013/0014, mirrors `EFSRouter._findDataAtPath`).
 *
 * The DataRef carries `{ uid, chainId, resolvedBy }` so a ref handed to `fetch`
 * alone still verifies (review A1/A2).
 *
 * ## Reserved-key PROPERTY reads (`contentType` / `contentHash` / `size`)
 *
 * Reserved metadata is stored as a PROPERTY bound under the DATA, addressed by a
 * key-anchor and a per-attester binding PIN (write graph `reads/../writes/graph.ts`).
 * To read one lens-scoped (mirrors `EFSRouter._getContentType`):
 *   1. `resolveAnchor(dataUID, key, PROPERTY_SCHEMA_UID)` → keyAnchor (0 ⇒ absent);
 *   2. `getActivePinTarget(keyAnchor, attester, PROPERTY_SCHEMA_UID)` → propertyUID
 *      (the attester's active binding; 0 ⇒ this attester set no value);
 *   3. `eas.getAttestation(propertyUID).data` → decode the `string value`.
 * The `attester` MUST be `resolvedBy` (the winning lens), so the value read is the
 * one the trusted attester attached — not a third party's.
 */

import type { Address, Hex } from 'viem'
import { edgeResolverAbi } from '../chain/abi/edgeResolver.js'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { indexerAbi } from '../chain/abi/indexer.js'
import { easAbi } from '../eas/abi.js'
import type { DataRef, DataUID, FileStat, ReadOptions, ReadResult } from '../types.js'
import {
  type FileSystemItem,
  type ReadContext,
  ZERO_UID,
  decodePropertyValue,
  read,
  resolveAttesters,
} from './context.js'
import { ParentNotFoundError, resolvePathToAnchor } from './resolve.js'

/** The full active-placement resolution: the file's DATA UID + the winning lens. */
export type ResolvedPlacement = {
  /** The active DATA UID at the path under the lens. */
  dataUID: DataUID
  /** The placement (lens) attester whose active PIN won — `resolvedBy`. */
  resolvedBy: Address
  /** The file's own anchor UID (the parent of its placements). */
  fileAnchorUID: Hex
}

/** Build the static {@link DataRef} for a resolved placement on this chain. */
function toDataRef(dataUID: DataUID, chainId: number, resolvedBy: Address): DataRef {
  return { __brand: 'DataRef', uid: dataUID, chainId, resolvedBy }
}

/**
 * Resolve a path to the active DATA placement under the lens, or `null` when the
 * file's anchor does not exist or no attester in the lens placed data there.
 *
 * @throws {LensRequired} when no lens/wallet is available.
 */
export async function resolvePlacement(
  ctx: ReadContext,
  path: string,
  opts: ReadOptions | undefined,
): Promise<ResolvedPlacement | null> {
  const attesters = await resolveAttesters(ctx, opts)
  const { contracts, schemas } = ctx.deployment

  // 1. Walk to the file's OWN anchor (file name included). A missing segment means
  //    the file (or a parent folder) does not exist — surfaced as `null`, not a throw.
  let fileAnchorUID: Hex
  try {
    fileAnchorUID = await resolvePathToAnchor(ctx.publicClient as never, contracts.indexer, path)
  } catch (err) {
    if (err instanceof ParentNotFoundError) return null
    throw err
  }
  if (fileAnchorUID === ZERO_UID) return null

  // 2. Winning placement under the lens. One page of size = lens length is enough:
  //    getFilesAtPath yields at most one item per attester and first-wins ordering
  //    means the first item IS the winner.
  const page = await read<{ items: readonly FileSystemItem[]; nextCursor: Hex }>(ctx.publicClient, {
    address: contracts.fileView,
    abi: fileViewAbi,
    functionName: 'getFilesAtPath',
    args: [fileAnchorUID, attesters, schemas.data, '0x', BigInt(attesters.length)],
  })

  const winner = page.items.find((it) => it.hasData && it.uid !== ZERO_UID)
  if (!winner) return null
  return {
    dataUID: winner.uid as DataUID,
    resolvedBy: winner.attester,
    fileAnchorUID,
  }
}

/**
 * `efs.fs.resolve(path, opts?)` — resolve a path to its active {@link DataRef}
 * under the lens (the winning placement's DATA UID + chainId + `resolvedBy`).
 * Returns `null` when nothing is placed there under the lens.
 */
export async function resolve(
  ctx: ReadContext,
  path: string,
  opts?: ReadOptions,
): Promise<ReadResult | null> {
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) return null
  const data = toDataRef(placement.dataUID, ctx.deployment.chainId, placement.resolvedBy)
  return { data, resolvedBy: placement.resolvedBy }
}

/**
 * Read a reserved-key PROPERTY value bound under `dataUID`, scoped to `attester`
 * (the winning lens). Returns `undefined` when the key anchor or the attester's
 * binding is absent, or the value is empty. Mirrors `EFSRouter._getContentType`.
 */
export async function readReservedProperty(
  ctx: ReadContext,
  dataUID: Hex,
  attester: Address,
  key: 'contentType' | 'contentHash' | 'size',
): Promise<string | undefined> {
  const { contracts, schemas } = ctx.deployment

  const keyAnchor = await read<Hex>(ctx.publicClient, {
    address: contracts.indexer,
    abi: indexerAbi,
    functionName: 'resolveAnchor',
    args: [dataUID, key, schemas.property],
  })
  if (keyAnchor === ZERO_UID) return undefined

  const propertyUID = await read<Hex>(ctx.publicClient, {
    address: contracts.edgeResolver,
    abi: edgeResolverAbi,
    functionName: 'getActivePinTarget',
    args: [keyAnchor, attester, schemas.property],
  })
  if (propertyUID === ZERO_UID) return undefined

  const att = await read<{ data: Hex }>(ctx.publicClient, {
    address: contracts.eas,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [propertyUID],
  })
  return decodePropertyValue(att.data)
}

/**
 * `efs.fs.stat(path, opts?)` — metadata at a path without fetching bytes. Returns
 * the discriminated {@link FileStat}: `{exists:false}` when nothing is placed
 * under the lens, else `{exists:true, data, resolvedBy, contentType?, size?}`. The
 * `size` and `contentType` come from the reserved-key PROPERTYs, scoped to the
 * winning lens.
 */
export async function stat(ctx: ReadContext, path: string, opts?: ReadOptions): Promise<FileStat> {
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) return { exists: false }

  const { dataUID, resolvedBy } = placement
  const [contentType, sizeStr] = await Promise.all([
    readReservedProperty(ctx, dataUID, resolvedBy, 'contentType'),
    readReservedProperty(ctx, dataUID, resolvedBy, 'size'),
  ])

  const data = toDataRef(dataUID, ctx.deployment.chainId, resolvedBy)
  const size = parseSize(sizeStr)
  return {
    exists: true,
    data,
    resolvedBy,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(size !== undefined ? { size } : {}),
  }
}

/** Parse the `size` PROPERTY (a decimal byte-count string) to a bigint, tolerant
 * of a malformed value (→ undefined, never a throw). */
function parseSize(s: string | undefined): bigint | undefined {
  if (s === undefined || !/^\d+$/.test(s)) return undefined
  try {
    return BigInt(s)
  } catch {
    return undefined
  }
}
