/**
 * Byte fetching + verification — the second half of `efs.fs.read` and all of
 * `efs.fs.fetch(ref)`.
 *
 * Given a {@link DataRef} (DATA UID + chainId + `resolvedBy`):
 *   1. `EFSFileView.getDataMirrors(dataUID, start, length)` → the active mirrors
 *      (revoked excluded on-chain, EFSFileView.sol:919). We scope to the winning
 *      lens (`resolvedBy`) — only that attester's mirrors are trusted (mirrors
 *      mirror `EFSRouter._getBestMirrorURI`'s lens scoping).
 *   2. Read the author's attested `contentHash` PROPERTY, scoped to `resolvedBy`.
 *   3. Hand the mirror URIs + that contentHash to the hardened {@link fetchVerified}
 *      engine (SSRF guard, size cap, data: decode, hash check). We DO NOT
 *      reimplement fetching — this is pure orchestration over `mirror/fetch.ts`.
 *
 * Verification is **trust-relative** (ADR-0006, review A2/A9): a `mismatch` /
 * `no-claim` / `malformed-claim` is reported on the returned {@link EfsFile}, never
 * thrown — the caller decides whether to trust unverified bytes. We only throw when
 * NO mirror yielded bytes at all ({@link AllMirrorsFailedError}, classified).
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { classifyError } from '../errors.js'
import { FileNotFoundError } from '../errors.js'
import { type FetchVerifiedOptions, type Mirror, fetchVerified } from '../mirror/fetch.js'
import type { DataRef, EfsFile, FetchOptions, ReadOptions } from '../types.js'
import { type ReadContext, read } from './context.js'
import { readReservedProperty, resolvePlacement } from './file.js'

/** A row returned by `getDataMirrors`. */
type MirrorItem = {
  uid: Hex
  transportDefinition: Hex
  uri: string
  attester: Address
  timestamp: bigint
}

/** How many mirrors to read per `getDataMirrors` window. */
const MIRROR_PAGE = 50
/** Hard cap on mirror rows scanned (matches the router's 500-row ceiling). */
const MAX_MIRRORS = 500

/**
 * Read the active mirror URIs for a DATA UID, scoped to the winning lens. Pages
 * through `getDataMirrors` (already revoked-excluded) and keeps only mirrors whose
 * `attester` is `resolvedBy` — a third party must not inject a mirror onto data
 * served under someone else's lens.
 */
async function lensMirrorUris(
  ctx: ReadContext,
  dataUID: Hex,
  resolvedBy: Address,
): Promise<string[]> {
  const uris: string[] = []
  for (let start = 0; start < MAX_MIRRORS; start += MIRROR_PAGE) {
    const rows = await read<readonly MirrorItem[]>(ctx.publicClient, {
      address: ctx.deployment.contracts.fileView,
      abi: fileViewAbi,
      functionName: 'getDataMirrors',
      args: [dataUID, BigInt(start), BigInt(MIRROR_PAGE)],
    })
    for (const m of rows) {
      if (m.attester.toLowerCase() === resolvedBy.toLowerCase() && m.uri.length > 0) {
        uris.push(m.uri)
      }
    }
    if (rows.length < MIRROR_PAGE) break // last (short) window
  }
  return uris
}

/**
 * Fetch + verify the bytes for a {@link DataRef}. Backs `efs.fs.fetch(ref)` and the
 * tail of `efs.fs.read`. `opts.verify` defaults to `true`; when `false`, mirrors
 * are still fetched but the attested `contentHash` lookup is skipped and the
 * verification is reported as `no-claim`.
 *
 * @throws {EfsError} (classified {@link AllMirrorsFailedError}) when no mirror
 *   yielded bytes.
 */
export async function fetchRef(
  ctx: ReadContext,
  ref: DataRef,
  opts?: FetchOptions,
): Promise<EfsFile> {
  const resolvedBy = ref.resolvedBy
  const verify = opts?.verify !== false

  let uris = await lensMirrorUris(ctx, ref.uid, resolvedBy)
  // Transport restriction (review A8): when the caller pins transports, keep only
  // mirrors whose scheme is allowed, preserving the on-chain priority order.
  if (opts?.transports && opts.transports.length > 0) {
    const allow = new Set(opts.transports.map((t) => t.toLowerCase()))
    // `web3://` is the SDK's `web3` transport; map the scheme back through the alias.
    uris = uris.filter((u) => allow.has(schemeName(u)))
  }

  // The author's attested contentHash, scoped to the winning lens. Skipped when
  // verification is off (then the engine reports `no-claim`).
  const claimedHash = verify
    ? await readReservedProperty(ctx, ref.uid, resolvedBy, 'contentHash')
    : undefined

  // `FetchOptions.transports` is applied as a mirror-list restriction above; the
  // engine then tries the surviving mirrors in their on-chain priority order. The
  // remaining FetchOptions (gateway overrides + SSRF egress controls) thread into
  // the engine so a caller with its own egress policy (e.g. a local fork node
  // serving a loopback `https://` mirror) can fetch — off by default (the guard
  // stays on, public gateways stay default).
  const mirrors: Mirror[] = uris.map((uri) => ({ uri }))
  const engineOpts: FetchVerifiedOptions = {
    ...(opts?.ipfsGateways !== undefined ? { ipfsGateways: opts.ipfsGateways } : {}),
    ...(opts?.arweaveGateways !== undefined ? { arweaveGateways: opts.arweaveGateways } : {}),
    ...(opts?.allowPrivateHosts !== undefined ? { allowPrivateHosts: opts.allowPrivateHosts } : {}),
    ...(opts?.allowHosts !== undefined ? { allowlist: opts.allowHosts } : {}),
    ...(opts?.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  }
  try {
    const result = await fetchVerified(mirrors, claimedHash, engineOpts)
    return {
      bytes: result.bytes,
      verification: result.verification,
      ...(result.contentType !== undefined ? { contentType: result.contentType } : {}),
      hashAuthor: resolvedBy,
    }
  } catch (err) {
    throw classifyError(err)
  }
}

/**
 * `efs.fs.cat(path, opts?)` — resolve a path to its active placement under the
 * lens, then fetch + verify its bytes. The full read pipeline (resolve → mirrors
 * → fetch → verify). The declared `efs.fs.read` keeps its `ReadResult | null`
 * (resolve-only) shape; `cat` is the byte-returning verb that yields an
 * {@link EfsFile} with the trust-relative verification status.
 *
 * @throws {FileNotFoundError} when nothing is placed at `path` under the lens.
 * @throws {LensRequired} when no lens/wallet is available.
 */
export async function cat(
  ctx: ReadContext,
  path: string,
  opts?: ReadOptions & FetchOptions,
): Promise<EfsFile> {
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) throw new FileNotFoundError(path)
  const ref: DataRef = {
    __brand: 'DataRef',
    uid: placement.dataUID,
    chainId: ctx.deployment.chainId,
    resolvedBy: placement.resolvedBy,
  }
  return fetchRef(ctx, ref, opts)
}

/** SDK transport name for a mirror URI scheme (`web3://` → `web3`, `ar://` →
 * `arweave`), used to honor `FetchOptions.transports`. */
function schemeName(uri: string): string {
  const raw = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase() ?? ''
  if (raw === 'ar') return 'arweave'
  return raw
}
