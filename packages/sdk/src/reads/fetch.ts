/**
 * Byte fetching + verification — `efs.fs.read(pathOrRef)` and the value sugar
 * (`readText`/`readBytes`/`readJson`).
 *
 * Given a path or a {@link DataRef} (DATA UID + chainId + `resolvedBy`):
 *   1. `EFSFileView.getDataMirrors(dataUID, resolvedBy, start, length)` →
 *      the winning lens's active mirrors (lens-scoped: the `attester` arg is required;
 *      revoked excluded on-chain). We pass the winning attester so a foreign attester's
 *      mirror can never surface — the scope is enforced by the view, not by post-filtering.
 *   2. Read the author's attested `contentHash` PROPERTY, scoped to `resolvedBy`.
 *   3. Hand the mirror URIs + that contentHash to the hardened {@link fetchVerified}
 *      engine (SSRF guard, size cap, data: decode, hash check) — pure orchestration.
 *
 * ## Two trust postures (sdk-read-surface)
 *
 *   - **`read` → {@link EfsFile}:** verification is reported on the result
 *     (`verification`), never thrown — the caller decides whether to trust unverified
 *     bytes. `.text()`/`.json()` are PURE decodes of the in-hand bytes (no I/O). The
 *     only throw is `FileNotFound` (nothing placed) / `Revoked` (winning record
 *     revoked) / `AllMirrorsFailed` (no mirror yielded bytes).
 *   - **value sugar (`readText`/`readBytes`/`readJson`) → bare value:** FAIL-CLOSED.
 *     A bare value has nowhere to carry a status, so a verification problem MUST
 *     throw (`ContentHashMismatch`/`MalformedClaim`) by default — `{verify:false}`
 *     opts out. This is how the one-liner stays trust-safe.
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { classifyError } from '../errors.js'
import { ContentHashMismatch, EfsError, FileNotFoundError, MalformedClaim } from '../errors.js'
import { type FetchVerifiedOptions, type Mirror, fetchVerified } from '../mirror/fetch.js'
import { type Web3ReadClient, readWeb3Bytes } from '../mirror/web3.js'
import type {
  DataRef,
  EfsFile,
  ExpandToken,
  FetchOptions,
  FileAttestations,
  ReadOpts,
} from '../types.js'
import { attestationFor } from './attestations.js'
import { type ReadContext, read as readContract } from './context.js'
import { readReservedProperty, resolvePlacement } from './file.js'

/** A row returned by `getDataMirrors` (lens-scoped). */
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
 * Read the active mirror URIs for a DATA UID, scoped to the winning lens via the
 * lens-scoped view. `getDataMirrors(dataUID, attester, …)` returns ONLY the named
 * attester's mirrors (already revoked-excluded), so no post-filtering by attester
 * is needed — the scope is enforced on-chain.
 */
async function lensMirrorUris(
  ctx: ReadContext,
  dataUID: Hex,
  resolvedBy: Address,
): Promise<string[]> {
  const uris: string[] = []
  for (let start = 0; start < MAX_MIRRORS; start += MIRROR_PAGE) {
    const rows = await readContract<readonly MirrorItem[]>(ctx.publicClient, {
      address: ctx.deployment.contracts.fileView,
      abi: fileViewAbi,
      functionName: 'getDataMirrors',
      args: [dataUID, resolvedBy, BigInt(start), BigInt(MIRROR_PAGE)],
    })
    for (const m of rows) {
      if (m.uri.length > 0) uris.push(m.uri)
    }
    if (rows.length < MIRROR_PAGE) break // last (short) window
  }
  return uris
}

/**
 * Fetch + verify the bytes for a {@link DataRef}. `opts.verify` defaults to `true`;
 * when `false`, mirrors are still fetched but the `contentHash` lookup is skipped
 * and verification is reported as `no-claim`. Returns an {@link EfsFile} carrying
 * pure `.text()`/`.json()` decoders and the trust-relative `verification` status —
 * a mismatch is NEVER thrown here (it is on the value-sugar path).
 *
 * @throws {EfsError} (classified {@link AllMirrorsFailedError}) when no mirror
 *   yielded bytes.
 */
export async function fetchRef(
  ctx: ReadContext,
  ref: DataRef,
  opts?: FetchOptions,
): Promise<EfsFile> {
  // Fail closed on a cross-chain ref: a DataRef carries its origin chain, but EAS UIDs
  // and web3:// mirrors are NOT chain-qualified — using one against another chain's
  // deployment would silently read the wrong contracts. (review A1 / cross-chain.)
  if (ref.chainId !== ctx.deployment.chainId) {
    throw new EfsError(
      `EFS read: this DataRef is for chain ${ref.chainId}, but the client is connected to chain ${ctx.deployment.chainId}. EAS UIDs and web3:// mirrors are not chain-qualified, so reading it here would resolve a different deployment. Use a client connected to chain ${ref.chainId}.`,
      { code: 'WrongChain' },
    )
  }

  const resolvedBy = ref.resolvedBy
  const verify = opts?.verify !== false

  let uris = await lensMirrorUris(ctx, ref.uid, resolvedBy)
  // Transport restriction (review A8): when the caller pins transports, keep only
  // mirrors whose scheme is allowed, preserving the on-chain priority order.
  if (opts?.transports && opts.transports.length > 0) {
    const allow = new Set(opts.transports.map((t) => t.toLowerCase()))
    uris = uris.filter((u) => allow.has(schemeName(u)))
  }

  // The author's attested contentHash, scoped to the winning lens. Skipped when
  // verification is off (then the engine reports `no-claim`).
  const claimedHash = verify
    ? (await readReservedProperty(ctx, ref.uid, resolvedBy, 'contentHash')).value
    : undefined

  const mirrors: Mirror[] = uris.map((uri) => ({ uri }))
  const engineOpts: FetchVerifiedOptions = {
    ...(opts?.ipfsGateways !== undefined ? { ipfsGateways: opts.ipfsGateways } : {}),
    ...(opts?.arweaveGateways !== undefined ? { arweaveGateways: opts.arweaveGateways } : {}),
    ...(opts?.allowPrivateHosts !== undefined ? { allowPrivateHosts: opts.allowPrivateHosts } : {}),
    ...(opts?.allowHosts !== undefined ? { allowlist: opts.allowHosts } : {}),
    ...(opts?.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    // Thread the read `publicClient` into the `web3://` (SSTORE2) read transport so
    // on-chain-stored files read back. Enabled only when the client can read bytecode
    // (`getCode`) — a real viem PublicClient always can. The engine stays chain-free;
    // the reader is the only chain-touching closure.
    ...(typeof ctx.publicClient.getCode === 'function'
      ? {
          web3Reader: (uri: string, o?: { maxBytes?: number }) =>
            readWeb3Bytes(uri, ctx.publicClient as Web3ReadClient, o?.maxBytes),
        }
      : {}),
  }
  try {
    const result = await fetchVerified(mirrors, claimedHash, engineOpts)
    return makeEfsFile(result.bytes, result.verification, result.contentType, resolvedBy)
  } catch (err) {
    throw classifyError(err)
  }
}

/** Assemble an {@link EfsFile} with PURE `.text()`/`.json()` over the in-hand bytes
 * (no I/O — the decode footgun the design forbids is a hidden network call, which
 * these are not). */
function makeEfsFile(
  bytes: Uint8Array,
  verification: EfsFile['verification'],
  contentType: string | undefined,
  hashAuthor: Address | undefined,
): EfsFile {
  return {
    bytes,
    verification,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(hashAuthor !== undefined ? { hashAuthor } : {}),
    text() {
      return new TextDecoder().decode(bytes)
    },
    json<T = unknown>(): T {
      return JSON.parse(new TextDecoder().decode(bytes)) as T
    },
  }
}

/**
 * `efs.fs.read(pathOrRef, opts?)` — the file's content (sdk-read-surface). Accepts a
 * PATH string OR a {@link DataRef} (folds in the old `fetch(ref)`). For a path it
 * resolves the active placement under the lens, then fetches + verifies its bytes.
 * Returns an {@link EfsFile} with a trust-relative `verification` status (never
 * thrown here) + pure `.text()`/`.json()`.
 *
 * @throws {FileNotFoundError} when a PATH resolves to nothing under the lens.
 * @throws {LensRequired} when a PATH read has no lens/wallet available.
 */
export async function read(
  ctx: ReadContext,
  pathOrRef: string | DataRef,
  opts?: ReadOpts & FetchOptions,
): Promise<EfsFile> {
  if (typeof pathOrRef !== 'string') {
    // A DataRef carries its own lens (`resolvedBy`) — no path resolution needed.
    return fetchRef(ctx, pathOrRef, opts)
  }
  const path = pathOrRef
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) throw new FileNotFoundError(path)
  const ref: DataRef = {
    __brand: 'DataRef',
    uid: placement.dataUID,
    chainId: ctx.deployment.chainId,
    resolvedBy: placement.resolvedBy,
  }
  const file = await fetchRef(ctx, ref, opts)

  // expand:['attestations'] on the byte path: hydrate the placement + contentHash
  // records onto the file's (optional) attestations bag. Kept minimal — the byte
  // path's primary product is bytes; `info`/`attestationsFor` are the metadata home.
  if (wantsAttestations(opts?.expand)) {
    file.attestations = await hydrateByteAttestations(
      ctx,
      ref,
      placement.placementPinUID,
      opts?.expand,
    )
  }
  return file
}

function wantsAttestations(expand: readonly ExpandToken[] | undefined): boolean {
  if (!expand) return false
  return expand.includes('attestations') || expand.includes('attestations.schema')
}

async function hydrateByteAttestations(
  ctx: ReadContext,
  ref: DataRef,
  placementPinUID: Hex | undefined,
  expand: readonly ExpandToken[] | undefined,
): Promise<FileAttestations> {
  const withSchema = expand?.includes('attestations.schema') ?? false
  const hashProp = await readReservedProperty(ctx, ref.uid, ref.resolvedBy, 'contentHash')
  const [placement, contentHash] = await Promise.all([
    placementPinUID !== undefined
      ? attestationFor(ctx, placementPinUID, { withSchema })
      : Promise.resolve(undefined),
    hashProp.propertyUID !== undefined
      ? attestationFor(ctx, hashProp.propertyUID, { withSchema })
      : Promise.resolve(undefined),
  ])
  const out: FileAttestations = {}
  if (placement) out.placement = placement
  if (contentHash) out.contentHash = contentHash
  return out
}

// ── Value sugar (fail-closed) ────────────────────────────────────────────────────

/** Map a verification status to the throw the fail-closed sugar owes (sdk-read-surface
 * §error matrix). `matches-author`/`no-claim` pass; the rest throw. With `verify:false`
 * nothing is checked (`no-claim`) so nothing throws. */
function assertVerified(file: EfsFile, path: string): void {
  switch (file.verification) {
    case 'mismatch':
      throw new ContentHashMismatch(path)
    case 'malformed-claim':
      throw new MalformedClaim(path)
    default:
      // 'matches-author' | 'no-claim' — trust-safe (no-claim only when verify:false
      // or the attester set no hash; the caller opted out / there is nothing to check).
      return
  }
}

/** `efs.fs.readBytes(path, opts?)` — the bare bytes (sdk-read-surface). Fail-closed:
 * throws `ContentHashMismatch`/`MalformedClaim` on a verification problem unless
 * `{verify:false}`. */
export async function readBytes(
  ctx: ReadContext,
  path: string,
  opts?: ReadOpts & FetchOptions,
): Promise<Uint8Array> {
  const file = await read(ctx, path, opts)
  assertVerified(file, path)
  return file.bytes
}

/** `efs.fs.readText(path, opts?)` — the bare UTF-8 string (sdk-read-surface).
 * Fail-closed (see {@link readBytes}). */
export async function readText(
  ctx: ReadContext,
  path: string,
  opts?: ReadOpts & FetchOptions,
): Promise<string> {
  const file = await read(ctx, path, opts)
  assertVerified(file, path)
  return file.text()
}

/** A minimal zod-like schema: anything with a `.parse(value) => T`. Lets `readJson`
 * accept a zod schema without a zod dependency. */
export type ParseSchema<T> = { parse(value: unknown): T }

/** `efs.fs.readJson<T>(path, opts?)` — the parsed JSON value (sdk-read-surface).
 * Fail-closed (see {@link readBytes}); an optional `schema` (e.g. a zod schema)
 * validates + narrows the parsed value. */
export async function readJson<T = unknown>(
  ctx: ReadContext,
  path: string,
  opts?: ReadOpts & FetchOptions & { schema?: ParseSchema<T> },
): Promise<T> {
  const file = await read(ctx, path, opts)
  assertVerified(file, path)
  const value = file.json<unknown>()
  return opts?.schema ? opts.schema.parse(value) : (value as T)
}

/** SDK transport name for a mirror URI scheme (`web3://` → `web3`, `ar://` →
 * `arweave`), used to honor `FetchOptions.transports`. */
function schemeName(uri: string): string {
  const raw = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase() ?? ''
  if (raw === 'ar') return 'arweave'
  return raw
}
