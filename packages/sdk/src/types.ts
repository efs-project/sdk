/** Public value + option shapes. Branded UID kinds because wrong-UID-kind is the
 * dominant integration bug (review DX-13). Static `DataRef` vs dynamic `PathRef`
 * never silently interconvert (sdk-architecture §5). Option/return types are
 * NAMED and exported so adding a field later is non-breaking (review C1). */

import type { Address, Hex } from 'viem'
import type { ContentHash, VerificationStatus } from './content/hash.js'
import type { EfsError } from './errors.js'
import type { Lens } from './lenses/resolve.js'

// ── Branded references ─────────────────────────────────────────────────────────

export type DataUID = Hex & { readonly __kind: 'DataUID' }

/** Static reference — these exact bytes / this version. Carries the chain it lives
 * on (review A1: a ref without its chain can't be resolved cross-chain) and the
 * attester that resolved it (review A2: `fetch(ref)` needs the author to verify
 * the attested `contentHash` — the verified two-step flow is broken without it). */
export type DataRef = {
  readonly __brand: 'DataRef'
  readonly uid: DataUID
  /** The EIP-155 chain this ref resolves on. */
  readonly chainId: number
  /** The attester whose lens won placement — the author `fetch` verifies against. */
  readonly resolvedBy: Address
}
/** Dynamic reference — whatever is active at this path now. */
export type PathRef = { readonly __brand: 'PathRef'; readonly path: string }

// ── Read options (shared) ──────────────────────────────────────────────────────

/**
 * The fixed, typed expansion union for `read`/`info` (sdk-read-surface §Two
 * orthogonal knobs). NOT free strings: each token opts the result into a nested
 * raw record (inlined as plain serializable data), and the SDK narrows the return
 * type on it (see {@link Expanded}). Max depth 2 — tighter than Stripe's 4 because
 * each level is a multicall round-trip, not a DB join. `'attestations.schema'` is
 * the only depth-2 token (the schema record behind each attestation).
 */
export type ExpandToken = 'attestations' | 'mirrors' | 'redirects' | 'attestations.schema'

/**
 * The two orthogonal read knobs (sdk-read-surface), shared by `read`/`info`/etc.:
 *
 *   - `fields` — PROJECTION. Which properties to populate. Reserved keys
 *     (`contentType`/`size`/`name`) fill typed slots; custom keys land in the
 *     `properties` bag. Runtime projection over a wide type (no static narrowing).
 *   - `expand` — DEPTH. Opt into nested raw records (attestations/mirrors/…). A
 *     fixed typed union; the return type narrows on it.
 *   - `verify` — fail-closed on the value-sugar path (default true).
 *
 * Generic over the expand tuple `E` so `read`/`info` can narrow their return.
 */
export type ReadOpts<E extends readonly ExpandToken[] = readonly ExpandToken[]> = {
  /** The lens to resolve through: a `Lens`, a raw `Address` (a literal lens), or
   * omitted (defaults to the client's `defaultLens`, then the connected wallet). */
  lens?: Lens | Address
  /** Projection — which properties to populate. Reserved keys → typed slots;
   * custom keys → the `properties` bag. Reserved meaning wins on collision. */
  fields?: string[]
  /** Depth — opt into nested raw records. Narrows the return type. */
  expand?: E
  /** Verify fetched bytes against the attester's `contentHash` (default true).
   * On the value-sugar path a mismatch throws (fail-closed) unless this is false. */
  verify?: boolean
}

/** Back-compat alias: the read option type was `ReadOptions` before the read-surface
 * refactor (sdk-read-surface). `ReadOpts` is the spec name; both point at the same
 * shape so existing imports keep working. */
export type ReadOptions = ReadOpts

/** Listing options: read options + pagination + (future) sort/schema filters. */
export type ListOptions = ReadOptions & {
  /** Max entries per page (the SDK windows the underlying bounded reads). */
  limit?: number
  /** Opaque resumable cursor from a prior `Page`. */
  cursor?: string
  /**
   * Tag-exclusion filter (contracts ADR-0048 / SDK ADR-0011). Each entry is a
   * TAG definition UID (`Hex`) or a human label (e.g. `'system'`/`'nsfw'`) the
   * SDK resolves to its `/tags/<name>` definition UID. Non-empty routes the
   * listing to the on-chain filtered view; empty/absent = unfiltered. Nothing is
   * excluded by default — pass `SAFETY_EXCLUDES` to opt into the common policy.
   *
   * @experimental — not yet implemented. The filtered-view wiring is tracked in
   * ADR-0011; passing a non-empty `excludes` THROWS `InvalidDirectoryQuery` today
   * (rather than silently returning an unfiltered listing, which would leak the
   * entries you asked to hide). The typed option is present so it lands additively.
   */
  excludes?: readonly (Hex | string)[]
  /**
   * Per-exclude inclusive weight threshold (`weight >= minWeights[k]`), aligned
   * by index with `excludes`. Omitted or length-mismatched ⇒ an all-zero vector
   * (ADR-0042 default). Capped at 8 excludes on-chain.
   *
   * @experimental — not yet implemented (rides with `excludes`; see ADR-0011).
   */
  minWeights?: readonly bigint[]
}

/** A named transport for mirror/fetch resolution. Open union (review A8): the
 * known transports are autocompletable, but an unrecognized name is still
 * assignable so adding one is never breaking. Mirrors the `TRANSPORT` value
 * allowlist in `mirror/transport.ts` (ADR-0010). */
export type TransportName =
  | 'web3'
  | 'arweave'
  | 'ipfs'
  | 'magnet'
  | 'https'
  | (string & Record<never, never>)

export type FetchOptions = {
  /** Verify fetched bytes against the author's attested contentHash (default true). */
  verify?: boolean
  /** Restrict/prioritize transports (e.g. `['ipfs', 'https']`); default = all by priority. */
  transports?: readonly TransportName[]
  /** IPFS gateway origins (e.g. `https://ipfs.io`), tried in order. Overrides the
   * built-in defaults for `ipfs://` mirror resolution. */
  ipfsGateways?: readonly string[]
  /** Arweave gateway origins (e.g. `https://arweave.net`), tried in order.
   * Overrides the built-in defaults for `ar://` mirror resolution. */
  arweaveGateways?: readonly string[]
  /**
   * Allow fetching from private/loopback/link-local hosts (disable the SSRF
   * guard). Default `false`. Set `true` ONLY when the caller has its own egress
   * controls — e.g. a local dev/fork node serving a `https://127.0.0.1` mirror.
   * The guard exists to stop an attacker-chosen mirror steering a server-side
   * fetch at internal endpoints, so leaving it on is the safe default.
   */
  allowPrivateHosts?: boolean
  /** Extra hostnames to allow past the SSRF guard even if they look private
   * (exact match, lowercased). A narrower alternative to `allowPrivateHosts`. */
  allowHosts?: readonly string[]
  /**
   * Inject a `fetch` implementation for byte retrieval (the off-chain engine
   * defaults to the global `fetch`). Escape hatch for callers that must control
   * egress at the transport level — a custom undici `Agent` (self-signed certs,
   * pinned DNS), a test stub, or a dev proxy. Most callers leave this unset.
   */
  fetchImpl?: typeof fetch
}

// ── Pagination ─────────────────────────────────────────────────────────────────

/** One page of a listing plus the cursor to resume after it (sdk-read-surface
 * §Pagination). The cursor field is `cursor` (the design's `.byPage()` shape),
 * `undefined` at the end. */
export type Page<T> = {
  items: readonly T[]
  /** Opaque cursor for the next page, or `undefined` at the end. */
  cursor?: string
}

/**
 * An async-iterable read (sdk-read-surface §Pagination). `for await` walks every
 * entry (paging hidden); `.byPage({limit,cursor})` fetches one bounded page + a
 * resume cursor; `.toArray({limit})` materializes with a MANDATORY cap (collect-all
 * requires an explicit bound). The iterator deliberately holds a live client; the
 * items it yields are inert plain DTOs.
 */
export type EfsList<T> = AsyncIterable<T> & {
  /** One bounded page + an opaque resume cursor (`CursorInvalid` on a stale cursor). */
  byPage(opts?: { limit?: number; cursor?: string }): Promise<Page<T>>
  /** Materialize entries into an array, up to `limit` (mandatory — bounds the fan-out). */
  toArray(opts: { limit: number }): Promise<T[]>
}

// ── Listings ─────────────────────────────────────────────────────────────────

/** One entry in a directory listing. The design specifies dir entries (a name
 * plus its anchoring UID and kind), not raw refs (review A11): a listing needs
 * the entry's name and whether it's a file or a directory, which a bare
 * `DataRef` can't carry. */
export type DirEntry = {
  /** The entry's name within the listed directory (the last path segment). */
  name: string
  /** Whether this entry is a file or a subdirectory. */
  kind: 'file' | 'dir'
  /** The static ref to the file's bytes (present for `kind: 'file'`). */
  dataUID?: DataUID
  /** The anchor UID for a subdirectory (present for `kind: 'dir'`). */
  anchorUID?: DataUID
}

// ── Writes ─────────────────────────────────────────────────────────────────────

/** How a batched write was delivered. Exported so additions are localized, not a
 * breaking change to an exhaustive `switch` (review C5). */
export type WriteMechanism = 'sequential' | 'eip5792' | 'erc4337' | 'gateway'

/** Lifecycle status of a write/batch (review A3). Models EIP-5792 status `600`
 * (a half-written file) which a binary `done`/`ok` can't represent — without it
 * an abandoned sequential run returns a success-shaped receipt.
 *
 * INTENTIONALLY OPEN (`string & {}` tail, like `EfsErrorCode`/`TransportName`):
 * EIP-5792's status wire format is still evolving (it already broke v1→v2), so a
 * new status must not be a semver-major for an exhaustive `switch`. */
export type CallStatus =
  | 'pending'
  | 'confirmed'
  | 'offchain-failed'
  | 'reverted'
  | 'partial'
  | (string & Record<never, never>)

export type WriteOptions = {
  contentType?: string
  onProgress?: (p: { step: number; total: number; phase: string }) => void
  resume?: WriteReceipt
  signal?: AbortSignal
  /**
   * Where to store the bytes when no `mirrors` are supplied. Default behavior
   * (omitted): if the content is within the client's on-chain auto-cap
   * (`write.onchainAutoLimit`, default 16 KB) it is stored ON-CHAIN via SSTORE2
   * and published as a `web3://` MIRROR — zero setup, no off-chain infra; over the
   * cap throws `PayloadTooLarge`. Set `'onchain'` to FORCE on-chain storage
   * regardless of size (bypasses the auto-cap; still single-chunk only — a payload
   * over ~24 KB throws `MultiChunkUnsupported`). Ignored when `mirrors` is given
   * (those take precedence and store off-chain).
   */
  storage?: 'onchain'
  /**
   * Retrieval URIs where the bytes live (one MIRROR per entry). When supplied,
   * the SDK does NOT store the content (on-chain or inline) — it publishes these
   * as the file's mirrors. The URI scheme of the FIRST entry selects the transport
   * definition (the on-chain `/transports/<scheme>` anchor) unless
   * `transportDefinition` is given. Omit to fall back to on-chain SSTORE2 storage
   * (the zero-infra default, size-capped — see `storage`).
   */
  mirrors?: readonly string[]
  /**
   * The on-chain `/transports/<scheme>` anchor UID for the MIRROR's
   * `transportDefinition` field. Overrides the per-scheme lookup in the resolved
   * deployment's `transports` map. Required when the deployment has not recorded
   * the relevant transport anchor (else the write throws `MissingTransport`).
   */
  transportDefinition?: Hex
  /**
   * The attester/lens the write authors under. Default: the connected wallet's
   * account (lenses key on the attester — ADR-0013/0014). Reserved additively;
   * the Tier-1 path always attests as the wallet account, so a value other than
   * the connected account is not yet honored (a later slice).
   */
  lens?: Address
  /**
   * `mkdir -p` for the write: when the target's ancestor folders don't yet exist,
   * create them in the SAME write. Each missing folder becomes one non-revocable
   * ANCHOR (a permanent folder), chained under the deepest existing ancestor, mined
   * before the file is placed under it.
   *
   * Default **`true`** — nested writes "just work". This is safe in EFS: anchors are
   * shared, content-neutral path nodes (an existing one is reused, only genuinely
   * missing segments are minted), and folder visibility is lens-scoped, so a folder
   * never appears in anyone's listing unless an attester in their lens has content
   * under it — a stray/typo'd folder pollutes no one else's view. Set **`false`** to
   * require the parents to already exist (a missing one throws `ParentNotFoundError`)
   * — useful as a typo guard, since a wrong path otherwise writes successfully to the
   * wrong place.
   */
  createParents?: boolean
}

/**
 * Client-level write defaults (the `write` key of the client config). Currently
 * just the on-chain auto-store cap; additive — new write defaults land here without
 * touching the per-call {@link WriteOptions}.
 */
export type WriteConfig = {
  /**
   * Cap (bytes) on the no-mirrors AUTO on-chain store. A `write(path, bytes)` with
   * no `mirrors` and no `storage` override stores on-chain when
   * `bytes.length <= onchainAutoLimit`, else throws `PayloadTooLarge`. Resets the
   * built-in default (16 KB). A per-call `{ storage: 'onchain' }` bypasses this cap
   * entirely (still single-chunk only). Must stay within one SSTORE2 chunk
   * (~24 KB) — a larger value still throws `MultiChunkUnsupported` at store time.
   */
  onchainAutoLimit?: number
}

/** Options for `fs.preview`. Reserved now (review A12) so the write-simulation
 * seam (e.g. price source, lens) can land additively without a signature change.
 * Intentionally near-empty until the preview pass defines its knobs. */
export type PreviewOptions = ReadOptions

/** A durable, serializable write session. `steps` are idempotent per
 * (path-qualified) id so a resume skips only mined work and never double-mints. */
export type WriteReceipt = {
  contentHash: ContentHash
  data?: DataRef
  steps: Array<{ id: string; uid?: DataUID; done: boolean }>
  signatureCount: number
  mechanism: WriteMechanism
  /** Lifecycle status; `'partial'`/`'reverted'` flag a half-written file. */
  status?: CallStatus
}

/** The op-type a batch entry performed — partial-failure UIs need to show which
 * kind of operation failed (review A6).
 *
 * INTENTIONALLY OPEN (`string & {}` tail, like `EfsErrorCode`/`WriteMechanism`):
 * new protocol primitives become new op-kinds over time, so adding one must not be
 * a semver-major for an exhaustive `switch`. `'redirect'` is included — the REDIRECT
 * schema is frozen and in the registry (ADR-0050). */
export type OperationKind =
  | 'write'
  | 'pin'
  | 'tag'
  | 'property'
  | 'list'
  | 'mirror'
  | 'sort'
  | 'redirect'
  | (string & Record<never, never>)

/** One operation's result inside a multi-op batch. */
export type OperationResult = {
  id: string
  /** Which op-type this entry performed. */
  kind: OperationKind
  ok: boolean
  uid?: DataUID
  /** The op's transaction hash, when it produced one. */
  txHash?: Hex
  /** A typed EFS error (carries `.code`); not a bare `Error` (review A6). */
  error?: EfsError
}

/** The result of executing a multi-op batch. */
export type BatchReceipt = {
  results: readonly OperationResult[]
  signatureCount: number
  mechanism: WriteMechanism
  /** Lifecycle status; `'partial'` when some ops landed and some did not. */
  status?: CallStatus
  /** True when some operations landed and some did not (review A3). */
  partialFailure?: boolean
  /** The transaction hashes the batch produced, in delivery order. */
  txHashes?: readonly Hex[]
}

export type WriteEstimate = {
  attestations: number
  transactions: number
  signatureCount: number
  chunkDeploys: number
  gas: bigint
  /** Estimated cost as a range, not a bare scalar (review A4 / future-proofing.md §5).
   * Omitted until pricing lands. */
  usd?: { min: number; max: number; priceSource?: string; asOf?: number }
  warnings: string[]
}

// ── Reads ──────────────────────────────────────────────────────────────────────

/** A resolved read pointer (`efs.fs.locate`): the data ref plus which attester/lens
 * won (review UX-4). `resolvedBy` is also folded into `DataRef` (review A2) so a ref
 * carried to `read(ref)` alone can still verify; kept here for the read-time view. */
export type ReadResult = { data: DataRef; resolvedBy: Address }

/**
 * A raw EAS attestation record (the `IEAS.getAttestation` return), inlined as plain
 * serializable data when `expand:['attestations']` is requested (sdk-read-surface
 * §Trust escalation). No result method performs I/O; this is fetched at request time
 * and frozen onto the DTO. Times are epoch seconds (`bigint`), not `Date` (query-key
 * stability). When `expand:['attestations.schema']` is also requested, `schema`
 * carries the resolved schema record.
 */
export type Attestation = {
  uid: Hex
  schema: Hex
  time: bigint
  expirationTime: bigint
  revocationTime: bigint
  refUID: Hex
  recipient: Address
  attester: Address
  revocable: boolean
  data: Hex
  /** Resolved schema record — present only when `expand:['attestations.schema']`. */
  schemaRecord?: SchemaRecord
}

/** A resolved EAS schema record (`SchemaRegistry.getSchema`), inlined for the
 * depth-2 `attestations.schema` expansion. Plain serializable data. */
export type SchemaRecord = {
  uid: Hex
  resolver: Address
  revocable: boolean
  schema: string
}

/** Per-field raw attestations, populated when `expand:['attestations']` is requested.
 * Keyed by the same reserved slots as {@link FileInfo.sourceUIDs}. */
export type FileAttestations = {
  placement?: Attestation
  contentType?: Attestation
  size?: Attestation
  contentHash?: Attestation
  name?: Attestation
}

/**
 * Per-field provenance UIDs — which on-chain record each value came from
 * (sdk-read-surface §provenance). ALWAYS present on a read result, NEVER projected
 * away. `placement` is the active placement PIN UID (`getActivePinSlot`); the rest
 * are the reserved-key PROPERTY attestation UIDs (`readReservedProperty`).
 */
export type SourceUIDs = {
  placement?: Hex
  contentType?: Hex
  size?: Hex
  contentHash?: Hex
  name?: Hex
}

/**
 * Fetched bytes + trust-relative verification — the `efs.fs.read` result
 * (sdk-read-surface). `.text()`/`.json()` are **pure** (no I/O — they decode the
 * in-hand `bytes`); a live re-fetch is never hidden behind a result method. The
 * value path is never trust-blind: `verification` is always present, and the
 * fail-closed sugar (`readText`/…) throws on a mismatch.
 */
export type EfsFile = {
  bytes: Uint8Array
  contentType?: string
  /** Trust-relative verification status against the lens attester's claim. */
  verification: VerificationStatus
  /** Whose contentHash claim was checked against (the winning lens attester). */
  hashAuthor?: Address
  /** Pure UTF-8 decode of `bytes` (no I/O). */
  text(): string
  /** Pure JSON parse of the UTF-8-decoded `bytes` (no I/O). */
  json<T = unknown>(): T
  /** Raw per-field attestations — present only when `expand:['attestations']` was
   * requested on the byte path (placement + contentHash records). */
  attestations?: FileAttestations
}

/**
 * Flat metadata DTO at a path — the `efs.fs.info` result (sdk-read-surface
 * §Value-first results). A plain serializable object; provenance
 * (`resolvedBy`/`verified`/`sourceUIDs`) is ALWAYS present and never projected away
 * (only `contentType`/`size`/`name`/`properties` are gated by `fields`). `size` is
 * `bigint` (matches viem; serialize at the JSON boundary). `attestations` is present
 * only when `expand:['attestations']` was requested.
 */
export type FileInfo = {
  exists: boolean
  contentType?: string
  size?: bigint
  name?: string
  /** Custom (non-reserved) `fields` keys land here; reserved keys take typed slots. */
  properties?: Record<string, string>
  ref?: DataRef
  // provenance — ALWAYS present, never projected away:
  /** The attester whose lens won placement. */
  resolvedBy: Address
  /** Trust status of the winning placement/claim. */
  verified: VerificationStatus | 'revoked' | 'unchecked'
  /** Per-field source UIDs (placement PIN + reserved-key PROPERTYs). */
  sourceUIDs: SourceUIDs
  /** Raw per-field attestations — present only with `expand:['attestations']`. */
  attestations?: FileAttestations
}

/**
 * Expand-narrowing helper (sdk-read-surface §Type narrowing — "narrow on `expand`
 * only", James 2026-06-19). Given a base result `T` and the requested expand tuple
 * `E`, makes `.attestations` NON-OPTIONAL when `'attestations'` (or the depth-2
 * `'attestations.schema'`) is in `E`. `fields` is deliberately NOT narrowed (it
 * stays runtime projection over the wide type). Verbs are generic over `E` and
 * return `Expanded<FileInfo, E>` so `info(p, {expand:['attestations']}).attestations`
 * type-checks without a non-null assertion.
 */
export type Expanded<
  T extends { attestations?: unknown },
  E extends readonly ExpandToken[],
> = 'attestations' extends E[number]
  ? T & { attestations: NonNullable<T['attestations']> }
  : 'attestations.schema' extends E[number]
    ? T & { attestations: NonNullable<T['attestations']> }
    : T

// ── Folder Overviews (ADR-0011) ─────────────────────────────────────────────────

/** The fixed anchor name a folder Overview is stored under (case-sensitive). */
export const OVERVIEW_NAME = 'README.md' as const

/** Opt-in directory-filter policy that hides the conventional system labels
 * (the Overview is `system`-tagged). Pass to `ListOptions.excludes`; not applied
 * by default (ADR-0011 §3). */
export const SAFETY_EXCLUDES: readonly string[] = ['system', 'nsfw']

/** Default cap on Overview bytes the SDK will buffer/return as text; larger
 * payloads surface as the `too-large` variant rather than being materialized. */
export const MAX_RENDER_BYTES = 256 * 1024

/** Options for an Overview read (extends read options; reserved for future
 * knobs following the `PreviewOptions` precedent). */
export type OverviewOptions = ReadOptions

/**
 * Result of `fs.overview()` — a discriminated union so "absent" is distinct from
 * "present but not markdown". `source` distinguishes an on-chain (editable) body
 * from a mirror-hosted (read-only) one.
 */
export type OverviewResult =
  | { kind: 'none' }
  | { kind: 'markdown'; text: string; source: 'onchain' | 'mirror' }
  | { kind: 'binary'; bytes: Uint8Array; contentType?: string; source: 'onchain' | 'mirror' }
  | { kind: 'too-large'; size: bigint }
