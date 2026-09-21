/**
 * Lens-scoped file resolution + reserved-key PROPERTY reads — the engine behind
 * `efs.fs.locate`, `efs.fs.info`, `efs.fs.exists`, and the first half of
 * `efs.fs.read`.
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
import type { VerificationStatus } from '../content/hash.js'
import { easAbi } from '../eas/abi.js'
import { encodeName } from '../names/segment.js'
import type {
  DataRef,
  DataUID,
  ExpandToken,
  FileAttestations,
  FileInfo,
  ReadOpts,
  ReadResult,
  RedirectRecord,
  SourceUIDs,
} from '../types.js'
import { attestationFor, attestationsForUIDs } from './attestations.js'
import {
  type FileSystemItem,
  LIVE_TRUST,
  type ReadContext,
  ZERO_UID,
  decodePropertyValue,
  read,
  resolveAttesters,
} from './context.js'
import {
  type HopBudget,
  type RedirectWalkStatus,
  resolveHopCap,
  walkSymlinks,
} from './redirects.js'
import { ParentNotFoundError, resolveFilePathToAnchor, splitPathToCanonical } from './resolve.js'

/** The reserved PROPERTY keys the SDK reads as typed slots. Custom `fields` keys
 * fall through to the `properties` bag. */
const RESERVED_KEYS = ['contentType', 'size', 'name', 'contentHash'] as const
type ReservedKey = (typeof RESERVED_KEYS)[number]

function isReservedKey(k: string): k is ReservedKey {
  return (RESERVED_KEYS as readonly string[]).includes(k)
}

/** The full active-placement resolution: the file's DATA UID + the winning lens. */
export type ResolvedPlacement = {
  /** The active DATA UID at the path under the lens. */
  dataUID: DataUID
  /** The attester whose claim won — `resolvedBy`. Normally the winning placement
   * PIN's attester; when a symlink resolved directly to a DATA (specs/09 §2
   * vector 1), it is the attester of that LAST symlink hop (who vouched for the
   * target), so mirrors/properties scope to the voucher. */
  resolvedBy: Address
  /** The file's own anchor UID (the parent of its placements). For a direct
   * symlink→DATA resolution this is the LAST symlink's source anchor. */
  fileAnchorUID: Hex
  /** The active placement PIN attestation UID (provenance: `sourceUIDs.placement`).
   * Read via `getActivePinSlot` against the file anchor under the winning lens.
   * Absent for a direct symlink→DATA resolution (no placement PIN involved). */
  placementPinUID?: Hex
  /** The SYMLINK hops followed during path resolution (specs/09 §2 — symlink is
   * the ONLY followed kind, ANCHOR-sourced), when `followRedirects` was set AND
   * at least one hop was taken. Absent ⇒ a literal walk. `sameAs`/`supersededBy`
   * are never here — an exact DATA never silently advances ("no silent
   * revision"); see `redirects.canonical`/`redirects.history` for those. */
  via?: readonly RedirectRecord[]
}

/**
 * Symlink-aware file-path resolution (specs/09 §2 — the navigational consumer
 * of {@link walkSymlinks}): walk the path segments and, after EACH landed
 * anchor, follow its lens-visible symlink chain in the SAME lens scope (§5).
 * A symlink target that is an ANCHOR continues descent under it (vector 2); a
 * DATA target at the leaf IS the resolved file (vector 1); a DATA target with
 * segments remaining is a not-found (a DATA has no children). ONE hop budget
 * spans the whole resolution — N segments cannot multiply the cap.
 */
async function resolveFilePathWithSymlinks(
  ctx: ReadContext,
  path: string,
  attesters: readonly Address[],
  cap: number,
): Promise<
  | { kind: 'anchor'; anchorUID: Hex; via: readonly RedirectRecord[] }
  | { kind: 'data'; dataUID: Hex; via: readonly RedirectRecord[] }
  | { kind: 'not-found' }
  | { kind: 'status'; status: RedirectWalkStatus; at: Hex; via: readonly RedirectRecord[] }
> {
  const { contracts, schemas } = ctx.deployment
  const segments = splitPathToCanonical(path)
  if (segments.length === 0) return { kind: 'not-found' } // the root is a folder, never a file

  const root = await read<Hex>(ctx.publicClient, {
    address: contracts.indexer,
    abi: indexerAbi,
    functionName: 'rootAnchorUID',
  })

  const via: RedirectRecord[] = []
  let parent = root

  for (let i = 0; i < segments.length; i++) {
    const isLeaf = i === segments.length - 1
    const seg = segments[i] as string
    // Leaf resolves the DATA-typed slot first (where the SDK writes file
    // anchors), generic as fallback; parents resolve generically — the same
    // order as the literal `resolveFilePathToAnchor`.
    let child = isLeaf
      ? await read<Hex>(ctx.publicClient, {
          address: contracts.indexer,
          abi: indexerAbi,
          functionName: 'resolveAnchor',
          args: [parent, seg, schemas.data],
        })
      : ZERO_UID
    if (child === ZERO_UID) {
      child = await read<Hex>(ctx.publicClient, {
        address: contracts.indexer,
        abi: indexerAbi,
        functionName: 'resolvePath',
        args: [parent, seg],
      })
    }
    if (child === ZERO_UID) return { kind: 'not-found' }

    // Landed on an anchor: follow its symlink chain in the SAME lens scope.
    // The budget is PER LANDED ANCHOR (specs/09 §8: the reference algorithm
    // re-initializes `hops = 0` on each follower re-entry after descent — the
    // D_MAX bound describes one walk, not the whole path; §3's exceedance
    // example is a single 17-CHAINED-symlink walk). Total work stays bounded
    // by segments × cap; the visited-set is likewise fresh per walk.
    const budget: HopBudget = { remaining: cap }
    const walk = await walkSymlinks(ctx, { uid: child, isData: false }, attesters, budget)
    via.push(...walk.via)
    if (walk.status !== 'Resolved') {
      // Router mapping (§8 notes): Dangling/DepthExceeded/CycleStopped are the
      // 404-equivalent; the surfaced node rides along for diagnostics.
      return { kind: 'status', status: walk.status, at: walk.uid, via }
    }
    if (walk.isData) {
      // Vector 1: the symlink resolved to a DATA. At the leaf that DATA is the
      // file; mid-path a DATA has no children ⇒ not-found.
      return isLeaf ? { kind: 'data', dataUID: walk.uid, via } : { kind: 'not-found' }
    }
    parent = walk.uid
  }
  return { kind: 'anchor', anchorUID: parent, via }
}

/** Build the static {@link DataRef} for a resolved placement on this chain. */
function toDataRef(dataUID: DataUID, chainId: number, resolvedBy: Address): DataRef {
  return { __brand: 'DataRef', profile: 'efs/v1', uid: dataUID, chainId, resolvedBy }
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
  opts: ReadOpts | undefined,
): Promise<ResolvedPlacement | null> {
  const attesters = await resolveAttesters(ctx, opts)
  const { contracts, schemas } = ctx.deployment

  // 1. Walk to the file's OWN anchor. Parent folders resolve generically; the terminal
  //    FILE segment resolves in the DATA-typed slot (the SDK writes file anchors at
  //    `(parent, name, DATA_SCHEMA_UID)`), with a generic fallback for legacy anchors —
  //    a generic-only walk would report SDK-written files as absent. A missing segment
  //    means the file (or a parent folder) does not exist — surfaced as `null`.
  //
  //    With `followRedirects` set, the walk is SYMLINK-AWARE (specs/09 §2): each
  //    landed anchor's lens-visible symlink chain is followed in the same lens
  //    scope. A non-`Resolved` walk status (Dangling/CycleStopped/DepthExceeded)
  //    maps to the 404-equivalent `null` (§8 router mapping) — never a throw.
  const cap = resolveHopCap(opts?.followRedirects)
  let fileAnchorUID: Hex
  let via: readonly RedirectRecord[] | undefined
  if (cap > 0) {
    const r = await resolveFilePathWithSymlinks(ctx, path, attesters, cap)
    if (r.kind === 'not-found' || r.kind === 'status') return null
    if (r.kind === 'data') {
      // Vector 1: symlink → DATA. That DATA is the resolved file; there is no
      // placement PIN. The voucher (resolvedBy) is the LAST symlink's attester,
      // and the file anchor is that symlink's source.
      const lastHop = r.via[r.via.length - 1] as RedirectRecord
      return {
        dataUID: r.dataUID as DataUID,
        resolvedBy: lastHop.attester,
        fileAnchorUID: lastHop.from,
        via: r.via,
      }
    }
    fileAnchorUID = r.anchorUID
    if (r.via.length > 0) via = r.via
  } else {
    try {
      fileAnchorUID = await resolveFilePathToAnchor(
        ctx.publicClient as never,
        contracts.indexer,
        path,
        schemas.data,
      )
    } catch (err) {
      if (err instanceof ParentNotFoundError) return null
      throw err
    }
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

  // The active placement PIN's attestation UID — provenance for `sourceUIDs.placement`
  // and the record `info`/`expand:['attestations']` hydrates for the placement. The
  // slot is keyed by (definition=file anchor, attester=winning lens, targetSchema=DATA);
  // `getActivePinSlot` returns `{ pinUID, targetID }` in one read.
  //
  // An EMPTY slot is a legitimate absence: the contract returns `pinUID: ZERO_UID`
  // (a value, not a revert), which we surface as no `placementPinUID`. An RPC /
  // transport failure is NOT absence — it must propagate (via `read`'s
  // `classifyError` funnel) rather than be swallowed into a false "no provenance".
  // So we do NOT `.catch()` here: only a real zero slot empties the provenance.
  const slot = await read<{ pinUID: Hex; targetID: Hex }>(ctx.publicClient, {
    address: contracts.edgeResolver,
    abi: edgeResolverAbi,
    functionName: 'getActivePinSlot',
    args: [fileAnchorUID, winner.attester, schemas.data],
  })

  // NOTE deliberately ABSENT here: there is NO DATA→DATA post-placement walk.
  // specs/09 §2 (ratified): a placed DATA UID never silently advances — `sameAs`
  // is canonicalization-only (`redirects.canonical`) and `supersededBy` is a
  // deliberate breadcrumb (`redirects.history`); a DATA cannot be a symlink
  // source (AliasResolver write guard), so the §8 follower entered at a placed
  // DATA always returns `Resolved` immediately. "Latest" is reached by the
  // path's placement PIN ("no silent revision": path = newest, UID = exact).
  return {
    dataUID: winner.uid as DataUID,
    resolvedBy: winner.attester,
    fileAnchorUID,
    // The slot read is SEQUENTIAL after getFilesAtPath, so a concurrent
    // re-placement by the winning attester can land between the two — the slot
    // then describes the NEW placement while `winner.uid` is the snapshot's
    // DATA. Provenance must describe the RETURNED snapshot: expose the PIN only
    // when the slot's target IS the winner; on mismatch omit it exactly like
    // the legitimate empty slot, never a `sourceUIDs.placement` (and expanded
    // attestation) that contradicts the DataRef it rides with.
    ...(slot.pinUID !== ZERO_UID && slot.targetID === winner.uid
      ? { placementPinUID: slot.pinUID }
      : {}),
    ...(via !== undefined ? { via } : {}),
  }
}

/**
 * `efs.fs.locate(path, opts?)` — resolve a path to its active {@link DataRef}
 * under the lens (the winning placement's DATA UID + chainId + `resolvedBy`).
 * Returns `null` when nothing is placed there under the lens — a normal absence,
 * never an error (sdk-read-surface §error matrix). Renamed from `resolve` (which
 * collided with `Promise.resolve` and the low-level `resolvePath`).
 */
export async function locate(
  ctx: ReadContext,
  path: string,
  opts?: ReadOpts,
): Promise<ReadResult | null> {
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) return null
  const data = toDataRef(placement.dataUID, ctx.deployment.chainId, placement.resolvedBy)
  return {
    data,
    resolvedBy: placement.resolvedBy,
    trust: LIVE_TRUST, // ADR-0015: every read today is a live chain-head read
    ...(placement.via !== undefined ? { via: placement.via } : {}),
  }
}

/** A reserved-key PROPERTY read: the decoded `value` (or `undefined`) PLUS the
 * `propertyUID` it came from (provenance — `sourceUIDs.<key>`). The UID is kept
 * even when the value decodes empty so `info`/`expand` can still hydrate the record. */
export type ReservedProperty = { value?: string; propertyUID?: Hex }

/**
 * Read a reserved-key PROPERTY bound under `dataUID`, scoped to `attester` (the
 * winning lens). Returns the decoded value AND the source `propertyUID` (provenance).
 * Both are `undefined` when the key anchor or the attester's binding is absent.
 * Mirrors `EFSRouter._getContentType`.
 */
export async function readReservedProperty(
  ctx: ReadContext,
  dataUID: Hex,
  attester: Address,
  key: 'contentType' | 'contentHash' | 'size' | 'name',
): Promise<ReservedProperty> {
  const { contracts, schemas } = ctx.deployment

  const keyAnchor = await read<Hex>(ctx.publicClient, {
    address: contracts.indexer,
    abi: indexerAbi,
    functionName: 'resolveAnchor',
    // Key-anchor names are canonical (specs/02). Reserved keys encode to
    // themselves; callers that smuggle CUSTOM keys through this reader
    // (props.get) get them encoded here — the key-lookup choke point.
    args: [dataUID, encodeName(key), schemas.property],
  })
  if (keyAnchor === ZERO_UID) return {}

  const propertyUID = await read<Hex>(ctx.publicClient, {
    address: contracts.edgeResolver,
    abi: edgeResolverAbi,
    functionName: 'getActivePinTarget',
    args: [keyAnchor, attester, schemas.property],
  })
  if (propertyUID === ZERO_UID) return {}

  const att = await read<{ data: Hex }>(ctx.publicClient, {
    address: contracts.eas,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [propertyUID],
  })
  const value = decodePropertyValue(att.data)
  return value !== undefined ? { value, propertyUID } : { propertyUID }
}

/**
 * `efs.fs.info(path, opts?)` — flat metadata DTO at a path (sdk-read-surface). Always
 * returns a {@link FileInfo}; absence is `exists:false` (never `null`). Provenance
 * (`resolvedBy`/`verified`/`sourceUIDs`) is ALWAYS present and never projected away;
 * only the value payload (`contentType`/`size`/`name`/`properties`) is gated by
 * `fields`. With no `fields`, the reserved trio (`contentType`/`size`/`name`) is read.
 * Custom `fields` keys land in `properties`. `expand:['attestations']` hydrates the
 * raw per-field records via one batched multicall (see `attestationsForUIDs`).
 *
 * Generic over the expand tuple so the return narrows: `expand:['attestations']`
 * makes `.attestations` non-optional (sdk-read-surface §Type narrowing).
 */
export async function info(ctx: ReadContext, path: string, opts?: ReadOpts): Promise<FileInfo> {
  const placement = await resolvePlacement(ctx, path, opts)
  if (!placement) {
    // Absent under the lens — a normal empty, not an error. Provenance still present.
    const absent: FileInfo = {
      exists: false,
      resolvedBy: '0x0000000000000000000000000000000000000000' as Address,
      verified: 'unchecked',
      trust: LIVE_TRUST, // the ABSENCE was determined against the live chain head too
      sourceUIDs: {},
    }
    // `expand:['attestations']` narrows `.attestations` to a NON-optional field at the
    // type level (see `Expanded<FileInfo, E>` / index.ts). An absent file has no source
    // UIDs, so attach an EMPTY bag rather than omitting the field — otherwise a caller
    // who relies on the narrowed type dereferences `info.attestations` and gets
    // `undefined` at runtime. Empty bag keeps the runtime shape consistent with the type.
    if (wantsAttestations(opts?.expand)) absent.attestations = {}
    return absent
  }

  const { dataUID, resolvedBy, placementPinUID } = placement

  // Which reserved keys to populate: the requested reserved `fields`, else the
  // default trio. Custom (non-reserved) `fields` keys are read too and bagged.
  const requested = opts?.fields
  const reservedToRead: ReservedKey[] = requested
    ? (requested.filter(isReservedKey) as ReservedKey[])
    : ['contentType', 'size', 'name']
  const customKeys = requested ? requested.filter((k) => !isReservedKey(k)) : []

  // Fan out every PROPERTY read in one tick (Promise.all → multicall coalescing).
  const reservedResults = await Promise.all(
    reservedToRead.map((k) => readReservedProperty(ctx, dataUID, resolvedBy, k)),
  )
  const customResults = await Promise.all(
    customKeys.map((k) => readCustomProperty(ctx, dataUID, resolvedBy, k)),
  )

  const byKey = new Map<string, ReservedProperty>()
  reservedToRead.forEach((k, i) => byKey.set(k, reservedResults[i] as ReservedProperty))

  const sourceUIDs: SourceUIDs = {
    ...(placementPinUID !== undefined ? { placement: placementPinUID } : {}),
  }
  for (const k of reservedToRead) {
    const uid = byKey.get(k)?.propertyUID
    if (uid !== undefined) sourceUIDs[k] = uid
  }

  const ref = toDataRef(dataUID, ctx.deployment.chainId, resolvedBy)
  const contentType = byKey.get('contentType')?.value
  const name = byKey.get('name')?.value
  const size = parseSize(byKey.get('size')?.value)

  // Custom fields → properties bag. Reserved meaning wins on a collision (the
  // custom-key list already excludes reserved keys, so no overwrite is possible).
  const properties: Record<string, string> = {}
  customKeys.forEach((k, i) => {
    const v = (customResults[i] as ReservedProperty).value
    if (v !== undefined) properties[k] = v
  })

  // Verified status: `info` never fetches or hashes the bytes, so it cannot claim
  // `matches-author`/`mismatch` — those are reserved for paths that actually
  // compared bytes (`read`/`cat`). A resolved placement only tells us the metadata
  // record exists and is not revoked (the view excludes revoked placements,
  // ADR-0051); it says nothing about whether the bytes match the claim. So the
  // honest status here is `unchecked`.
  const info: FileInfo = {
    exists: true,
    ref,
    resolvedBy,
    verified: 'unchecked',
    trust: LIVE_TRUST, // ADR-0015
    sourceUIDs,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  }

  // expand:['attestations'] — hydrate the per-field raw records in one batched
  // multicall over the collected source UIDs (allowFailure → degraded per-item).
  if (wantsAttestations(opts?.expand)) {
    info.attestations = await hydrateAttestations(ctx, sourceUIDs, opts?.expand)
  }

  return info
}

/**
 * `efs.fs.exists(path, opts?)` — cheap presence probe (sdk-read-surface). `true`
 * when something is placed at `path` under the lens, else `false`. Never throws
 * except on a network/RPC error (a missing lens still throws `LensRequired`, since
 * that is a caller config error, not a network condition — but the resolution
 * itself never converts an empty placement into a throw).
 */
export async function exists(ctx: ReadContext, path: string, opts?: ReadOpts): Promise<boolean> {
  const placement = await resolvePlacement(ctx, path, opts)
  return placement !== null
}

/** Read a CUSTOM (non-reserved) PROPERTY key, scoped to the lens. Same lookup as
 * the reserved keys — the key is just the anchor name. */
async function readCustomProperty(
  ctx: ReadContext,
  dataUID: Hex,
  attester: Address,
  key: string,
): Promise<ReservedProperty> {
  const { contracts, schemas } = ctx.deployment
  const keyAnchor = await read<Hex>(ctx.publicClient, {
    address: contracts.indexer,
    abi: indexerAbi,
    functionName: 'resolveAnchor',
    // Custom keys are HUMAN at the public surface — encode to the canonical
    // anchor name (specs/02) so `info(path, {fields:['my key']})` finds the
    // slot `props.set('my key')` wrote.
    args: [dataUID, encodeName(key), schemas.property],
  })
  if (keyAnchor === ZERO_UID) return {}
  const propertyUID = await read<Hex>(ctx.publicClient, {
    address: contracts.edgeResolver,
    abi: edgeResolverAbi,
    functionName: 'getActivePinTarget',
    args: [keyAnchor, attester, schemas.property],
  })
  if (propertyUID === ZERO_UID) return {}
  const att = await read<{ data: Hex }>(ctx.publicClient, {
    address: contracts.eas,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [propertyUID],
  })
  const value = decodePropertyValue(att.data)
  return value !== undefined ? { value, propertyUID } : { propertyUID }
}

/** Whether the expand tuple opts into attestation records (depth-1 or depth-2). */
function wantsAttestations(expand: readonly ExpandToken[] | undefined): boolean {
  if (!expand) return false
  return expand.includes('attestations') || expand.includes('attestations.schema')
}

/** Hydrate the per-field {@link FileAttestations} from the collected source UIDs in
 * one batched multicall. `attestations.schema` adds the depth-2 schema record. */
async function hydrateAttestations(
  ctx: ReadContext,
  sourceUIDs: SourceUIDs,
  expand: readonly ExpandToken[] | undefined,
): Promise<FileAttestations> {
  const withSchema = expand?.includes('attestations.schema') ?? false
  const entries = Object.entries(sourceUIDs).filter(([, uid]) => uid !== undefined) as [
    keyof FileAttestations,
    Hex,
  ][]
  const hydrated = await attestationsForUIDs(
    ctx,
    entries.map(([, uid]) => uid),
    { withSchema },
  )
  const out: FileAttestations = {}
  entries.forEach(([key], i) => {
    const att = hydrated[i]
    if (att) out[key] = att
  })
  return out
}

/** Re-export the single-UID hydrator (used by the byte path for `expand`). */
export { attestationFor }

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

/** Re-export for callers that referenced the verification type by name. */
export type { VerificationStatus }
