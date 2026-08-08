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
import { classifyError } from '../errors.js'
import {
  ContentHashMismatch,
  EfsError,
  FileNotFoundError,
  MalformedClaim,
  MissingContentHash,
  StaleTrust,
} from '../errors.js'
import {
  DEFAULT_MAX_BYTES,
  type FetchVerifiedOptions,
  type Mirror,
  fetchVerified,
} from '../mirror/fetch.js'
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
import { LIVE_TRUST, type ReadContext, read as readContract } from './context.js'
import { readReservedProperty, resolvePlacement } from './file.js'
import { scanActiveMirrors } from './mirror-scan.js'

/** Parse a `size` PROPERTY value (decimal byte count) to a safe number, or `undefined`
 * when absent/malformed/too-large-to-cap-safely (then no size cap is applied). */
function parseSize(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * Read the active mirror URIs for a DATA UID, scoped to the winning lens via the
 * lens-scoped view. `getDataMirrors(dataUID, attester, …)` returns ONLY the named
 * attester's mirrors (already revoked-excluded), so no post-filtering by attester
 * is needed — the scope is enforced on-chain. Paged over the RAW referencing
 * count (see reads/mirror-scan.ts): revoked holes never truncate the scan.
 */
async function lensMirrorUris(
  ctx: ReadContext,
  dataUID: Hex,
  resolvedBy: Address,
): Promise<string[]> {
  const rows = await scanActiveMirrors(ctx.publicClient, ctx.deployment, dataUID, resolvedBy)
  return rows.filter((m) => m.uri.length > 0).map((m) => m.uri)
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

  // Validate the caller cap BEFORE it becomes the fetch limit. The downstream cap checks
  // are all `>` comparisons, so a non-finite `maxBytes` slips the safety ceiling: `NaN`
  // never trips a `>` (an over-cap body reads as in-bounds) and `Infinity` disables the
  // 50 MB default outright — either lets an untrusted mirror buffer unbounded. A
  // non-positive cap is equally meaningless. Reject up front (fail closed) rather than
  // silently substituting a default that hides the caller bug.
  if (opts?.maxBytes !== undefined && (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0)) {
    throw new EfsError(
      `EFS read: \`maxBytes\` must be a finite positive number (got ${opts.maxBytes}). Omit it to use the ${DEFAULT_MAX_BYTES}-byte default ceiling.`,
      { code: 'InvalidArgument' },
    )
  }

  const resolvedBy = ref.resolvedBy
  const verify = opts?.verify !== false

  let uris = await lensMirrorUris(ctx, ref.uid, resolvedBy)
  // Transport restriction (review A8): when the caller pins transports, keep only
  // mirrors whose scheme is allowed, preserving the on-chain priority order.
  // An EXPLICITLY EMPTY list is honored as "no transports allowed" (zero
  // candidates → the read fails) — OMITTING the option is the allow-all form,
  // and silently widening `transports: []` from a computed security policy into
  // every scheme would invert the caller's restriction.
  if (opts?.transports !== undefined) {
    const allow = new Set(opts.transports.map((t) => t.toLowerCase()))
    uris = uris.filter((u) => allow.has(schemeName(u)))
  }

  // Author-attested metadata, scoped to the winning lens. `contentType` is ALWAYS
  // taken from the attestation (never the untrusted transport `Content-Type` header — a
  // gateway can change it independently of the lens-scoped metadata model). `contentHash`
  // + `size` drive verification and are only read when requested.
  const [attestedContentType, claimedHash, declaredSize] = await Promise.all([
    readReservedProperty(ctx, ref.uid, resolvedBy, 'contentType').then((p) => p.value),
    verify
      ? readReservedProperty(ctx, ref.uid, resolvedBy, 'contentHash').then((p) => p.value)
      : Promise.resolve(undefined),
    verify
      ? readReservedProperty(ctx, ref.uid, resolvedBy, 'size').then((p) => parseSize(p.value))
      : Promise.resolve(undefined),
  ])

  // Cap the fetch with the CALLER's ceiling only (opts.maxBytes, else the engine
  // default). The author's declared `size` is deliberately NOT folded into the
  // transport cap: making an (untrusted) claim the hard cap would turn any
  // under-declared size (size 1, two-byte body) into an every-mirror abort —
  // fs.read() would throw AllMirrorsFailed instead of reporting the documented
  // `verification: 'mismatch'` (docs/specs/content-hash.md). The declared-size
  // CONSISTENCY check runs uniformly post-fetch below; the safety ceiling
  // against unbounded buffering is the caller/default cap, which claims can
  // neither raise nor tighten.
  const effectiveMaxBytes = opts?.maxBytes

  const mirrors: Mirror[] = uris.map((uri) => ({ uri }))
  const engineOpts: FetchVerifiedOptions = {
    ...(opts?.ipfsGateways !== undefined ? { ipfsGateways: opts.ipfsGateways } : {}),
    ...(opts?.arweaveGateways !== undefined ? { arweaveGateways: opts.arweaveGateways } : {}),
    ...(opts?.allowPrivateHosts !== undefined ? { allowPrivateHosts: opts.allowPrivateHosts } : {}),
    ...(opts?.allowHosts !== undefined ? { allowlist: opts.allowHosts } : {}),
    ...(opts?.allowInsecureHttp !== undefined ? { allowInsecureHttp: opts.allowInsecureHttp } : {}),
    ...(opts?.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(effectiveMaxBytes !== undefined ? { maxBytes: effectiveMaxBytes } : {}),
    // Forward the caller's cancellation signal so a slow mirror read aborts promptly
    // (e.g. an aborted server request) instead of running to the per-attempt timeout.
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    // Thread the read `publicClient` into the `web3://` (SSTORE2) read transport so
    // on-chain-stored files read back. Enabled only when the client can read bytecode
    // (`getCode`) — a real viem PublicClient always can. The engine stays chain-free;
    // the reader is the only chain-touching closure.
    ...(typeof ctx.publicClient.getCode === 'function'
      ? {
          web3Reader: (uri: string, o?: { maxBytes?: number; signal?: AbortSignal }) =>
            readWeb3Bytes(uri, ctx.publicClient as Web3ReadClient, {
              ...(o?.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
              ...(o?.signal !== undefined ? { signal: o.signal } : {}),
            }),
        }
      : {}),
  }
  try {
    const result = await fetchVerified(mirrors, claimedHash, engineOpts)
    // Enforce the declared-size claim on the FETCHED bytes — uniformly, for
    // every declared size (0 included): bytes exceeding the declared size are
    // the documented MISMATCH (docs/specs/content-hash.md), reported on the
    // rich result rather than aborting the fetch (the claim is untrusted
    // metadata, not a transport cap).
    const verification =
      declaredSize !== undefined && BigInt(result.bytes.byteLength) > declaredSize
        ? ('mismatch' as const)
        : result.verification
    // Use the ATTESTED contentType (or omit) — never the untrusted transport header.
    return makeEfsFile(
      result.bytes,
      verification,
      attestedContentType,
      resolvedBy,
      result.mirrorUsed,
    )
  } catch (err) {
    // A caller CANCELLATION is not a mirror failure — it propagates
    // unclassified, matching the abort convention everywhere else in the SDK,
    // so UIs can distinguish "user cancelled" from "mirrors are down". The
    // signal check comes FIRST: `controller.abort(customReason)` may carry a
    // string/object reason with no `name`, which a name check alone would
    // misroute into the classifier. throwIfAborted rethrows the exact reason.
    opts?.signal?.throwIfAborted()
    if ((err as Error | undefined)?.name === 'AbortError') throw err
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
  mirrorUsed?: string,
): EfsFile {
  return {
    bytes,
    verification,
    // ADR-0015: every read today is a LIVE chain-head read, so the stamp is the
    // constant safe state. The offline/indexer sources populate the other
    // variants when their read paths land — the REQUIRED field is what stops
    // them from masquerading as live.
    trust: LIVE_TRUST,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(hashAuthor !== undefined ? { hashAuthor } : {}),
    ...(mirrorUsed !== undefined ? { mirrorUsed } : {}),
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
    // A DataRef carries its own lens (`resolvedBy`) — no path resolution needed. Still
    // honor `expand:['attestations']` so the common `locate() → read(ref, {expand})`
    // two-step gets a populated `attestations` bag (the generic signature narrows it to
    // non-optional). A DataRef has no placement PIN, so only the contentHash record is
    // hydrated (placement is omitted) — never left `undefined` where the type says set.
    const refFile = await fetchRef(ctx, pathOrRef, opts)
    if (wantsAttestations(opts?.expand)) {
      refFile.attestations = await hydrateByteAttestations(ctx, pathOrRef, undefined, opts?.expand)
    }
    return refFile
  }
  const path = pathOrRef
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) throw new FileNotFoundError(path)
  const ref: DataRef = {
    __brand: 'DataRef',
    profile: 'efs/v1',
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

/**
 * Trust-freshness gate for the fail-closed sugar (ADR-0015): the answer's
 * `trust.freshness` must satisfy the caller's `requireTrust` floor (default
 * `'as-of'` — accepts `current`/`as-of`, rejects content-only `stale`;
 * `'current'` rejects `as-of` too; `'any'` disables). Today every stamp is
 * `current`, so the gate cannot fire — it exists so a future offline/indexer
 * source cannot silently weaken readText/readBytes/readJson.
 * @throws {StaleTrust}
 */
export function assertTrust(
  file: EfsFile,
  path: string,
  require: 'current' | 'as-of' | 'any' | undefined,
): void {
  const floor = require ?? 'as-of'
  if (floor === 'any') return
  const { freshness } = file.trust
  const ok = floor === 'current' ? freshness === 'current' : freshness !== 'stale'
  if (!ok) throw new StaleTrust(file.trust, floor, path)
}

/** Map a verification status to the throw the fail-closed sugar owes (sdk-read-surface
 * §error matrix). `matches-author` passes; `mismatch`/`malformed-claim` always throw.
 * `no-claim` is the subtle one: it means NOTHING was verified — legitimate when the
 * caller opted out (`verify:false`), but a fail-closed problem when verification was
 * REQUESTED (the default) and the file simply has no contentHash claim. A bare value
 * has no status field to carry that, so we throw {@link MissingContentHash} rather than
 * silently hand back unverifiable bytes. `verifyRequested` = `opts.verify !== false`. */
export function assertVerified(file: EfsFile, path: string, verifyRequested: boolean): void {
  switch (file.verification) {
    case 'mismatch':
      throw new ContentHashMismatch(path)
    case 'malformed-claim':
      throw new MalformedClaim(path)
    case 'no-claim':
      // Opted out (`verify:false`) ⇒ acceptable. Verification requested but no claim
      // exists ⇒ fail closed (the bytes are unverifiable, and the bare helper can't warn).
      if (verifyRequested) throw new MissingContentHash(path)
      return
    default:
      // 'matches-author' — verified.
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
  assertVerified(file, path, opts?.verify !== false)
  assertTrust(file, path, opts?.requireTrust)
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
  assertVerified(file, path, opts?.verify !== false)
  assertTrust(file, path, opts?.requireTrust)
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
  assertVerified(file, path, opts?.verify !== false)
  assertTrust(file, path, opts?.requireTrust)
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
