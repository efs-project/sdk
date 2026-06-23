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

/** A folder ANCHOR's UID — the content-neutral path node a directory is, distinct
 * from the {@link DataUID} that identifies a file's bytes/version (review P3 / A11).
 * Branded apart because the two are NOT interchangeable: an anchor UID resolves a
 * folder (children, sub-anchors); a DATA UID resolves bytes — passing one where the
 * other is expected is the wrong-UID-kind integration bug the brands exist to catch.
 * A {@link DirEntry} carries a `DataUID` on its file variant and an `AnchorUID` on its
 * dir variant. Both are `Hex` at runtime (zero cost); the distinction is type-only. */
export type AnchorUID = Hex & { readonly __kind: 'AnchorUID' }

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
 *
 * Only the `attestations` family is hydrated today. `mirrors`/`redirects` expansion
 * is deliberately NOT in the union: until a verb actually hydrates them into a result
 * field, listing them would be a silent no-op (the token would type-check but expand
 * nothing). They are added back additively when implemented — read mirrors via
 * `efs.mirrors.list(...)` and redirects via the `followRedirects`/`ReadResult.via`
 * surface in the meantime.
 */
export type ExpandToken = 'attestations' | 'attestations.schema'

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
  /**
   * Follow active REDIRECT aliases (ADR-0050) at read time. The on-chain resolver
   * does NOT follow redirects — it is write-time-guards-only, and `EFSRouter` reads
   * only the DATA-pin slot — so following is the SDK's job, scoped to the read lens.
   *
   *   - `false` (DEFAULT) — do NOT follow; resolve the literal placement. (A redirect
   *     reroutes file *identity* with a larger blast radius than a normal PIN, and
   *     ADR-0050's normative resolution spec — lens precedence + cycle = lowest-UID-
   *     in-SCC — is not yet pinned. Off by default keeps reads literal and avoids the
   *     "silent teleport" footgun; opt in explicitly.)
   *   - `true` — follow the DATA-sourced dedup/versioning kinds (`sameAs`/
   *     `supersededBy`) from the resolved placement to their canonical terminal, up to
   *     the default hop cap (8; ADR-0050 `D_MAX`). NOTE: `symlink` (kind=2) is
   *     ANCHOR-sourced (a path alias), so path-level symlink resolution is NOT yet
   *     followed — it is deferred pending the ADR-0050 resolution-spec pin.
   *     `relatedVersion` (kind ≥ 3) is never auto-followed.
   *   - a `number` — follow with that explicit max-hop cap (≤ 32, the hard ceiling =
   *     `MAX_ANCHOR_DEPTH`). `0` is equivalent to `false`.
   *
   * On a cycle, throws {@link import('./errors.js').RedirectCycle}; over the cap,
   * throws {@link import('./errors.js').RedirectHopLimit} (fail-closed — a silent
   * stop at a partial chain would resolve to an attacker-influenceable node). The
   * result surfaces where it landed via {@link ReadResult.via}.
   */
  followRedirects?: boolean | number
}

/** The frozen REDIRECT `kind` literal union (ADR-0050; values in
 * {@link import('./writes/edge.js').REDIRECT_KIND}). Open tail: the kind taxonomy is
 * resolver+client convention (not in the schema UID), so a new kind name is additive
 * and must not break an exhaustive `switch`. */
export type RedirectKind =
  | 'sameAs'
  | 'supersededBy'
  | 'symlink'
  | 'relatedVersion'
  | (string & Record<never, never>)

/**
 * One decoded active REDIRECT record (ADR-0050) under a resolving lens — what
 * `efs.redirects.get` returns and a single hop in {@link ReadResult.via}.
 */
export type RedirectRecord = {
  /** The SOURCE this redirect points FROM (the EAS `refUID`). */
  from: Hex
  /** The DESTINATION this redirect points TO (the decoded `target`). */
  to: Hex
  /** The decoded `kind` discriminator (`0=sameAs`, `1=supersededBy`, `2=symlink`,
   * `3+`=reserved/never-auto-followed). The raw `uint16`. */
  kindCode: number
  /** The named kind, when recognized (else `undefined` for a reserved `kind >= 4`). */
  kind?: RedirectKind
  /** The REDIRECT attestation's own UID — the revoke handle for `redirects.remove`. */
  redirectUID: Hex
  /** The attester who asserted this redirect (the lens member whose redirect won). */
  attester: Address
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
   * listing to the on-chain filtered view (`getDirectoryPageFiltered`), lens-scoped
   * via the same attesters as the unfiltered read; empty/absent = unfiltered.
   * Nothing is excluded by default — pass `SAFETY_EXCLUDES` to opt into the common
   * policy. Capped at 8 excludes on-chain ({@link InvalidDirectoryQuery} above that).
   * An unresolvable label fails closed with {@link InvalidDirectoryQuery} (it is
   * never silently dropped, which would leak the entries you asked to hide).
   */
  excludes?: readonly (Hex | string)[]
  /**
   * Per-exclude inclusive weight threshold (`weight >= minWeights[k]`), aligned
   * by index with `excludes`. Omitted or length-mismatched ⇒ an all-zero vector
   * (ADR-0042 default). Capped at 8 excludes on-chain.
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
   * Allow plaintext `http://` mirrors (and `http://` redirect targets). Default
   * `false`. ADR-0010 names `https://` as the web transport; an attacker-authored
   * mirror could otherwise downgrade retrieval to cleartext (bytes stay hash-
   * verified, but availability/privacy/provenance over HTTP are tamperable). Set
   * `true` ONLY when the source is trusted — e.g. a local dev mirror at
   * `http://127.0.0.1` (pair with `allowPrivateHosts`). `https://` is unaffected.
   */
  allowInsecureHttp?: boolean
  /**
   * Inject a `fetch` implementation for byte retrieval (the off-chain engine
   * defaults to the global `fetch`). Escape hatch for callers that must control
   * egress at the transport level — a custom undici `Agent` (self-signed certs,
   * pinned DNS), a test stub, or a dev proxy. Most callers leave this unset.
   */
  fetchImpl?: typeof fetch
  /** Hard cap (bytes) on the payload buffered per fetch attempt; default 50 MB. The
   * reader stops once the running total exceeds it (a web3:// chunk walk bails
   * mid-stream), so an untrusted mirror can't force allocation past the cap. A smaller
   * author-declared `size` lowers this further, but a larger one NEVER raises it. */
  maxBytes?: number
  /** Cancellation signal forwarded to the mirror fetch engine — abort a slow/in-flight
   * byte read (e.g. an aborted server request) instead of waiting out the per-attempt
   * timeout. Applies to the `read`/`readText`/`readBytes`/`readJson` byte path. */
  signal?: AbortSignal
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
  /** The anchor UID for a subdirectory (present for `kind: 'dir'`). Branded
   * {@link AnchorUID} — a folder path node, distinct from a file's `dataUID`. */
  anchorUID?: AnchorUID
}

// ── Writes ─────────────────────────────────────────────────────────────────────

/** How a write was delivered. Open union (the `(string & {})` tail) so a new
 * execution path is additive, never a breaking change to an exhaustive `switch`
 * (review C5; wallet-arch review P2-C). `eip7702` = the user's EOA ran the EFS
 * routine in-account via a 7702 authorization; `gateway` = the delegated-attestation
 * relayer path. */
export type WriteMechanism =
  | 'sequential'
  | 'eip5792'
  | 'eip7702'
  | 'erc4337'
  | 'gateway'
  | (string & Record<never, never>)

/**
 * INTERNAL rich account profile — the input to the selector
 * (sdk-wallet-architecture §Core abstractions). Capability-shaped, NOT
 * EIP-5792 vocabulary on the public surface: the raw 5792 blob lives in `raw`,
 * so a future batch standard maps in without a break. Produced by
 * `detectAccount` (writes/detect.ts); never exposed directly — the curated
 * {@link AccountCapabilities} is the public view.
 */
export type AccountProfile = {
  /** The account that will actually sign (the attester the profile keys on). */
  address: Address
  /**
   * `eoa` (`getCode` = `0x`) — necessary-not-sufficient (an undeployed
   * counterfactual 4337 account is also `0x`); `eoa-7702-delegated`
   * (`0xef0100‖impl`); `smart-account` (any other code);
   * `unknown-counterfactual` reserved for an adapter that recognizes its own
   * pre-deploy account. Open union so a new kind is additive. */
  kind:
    | 'eoa'
    | 'eoa-7702-delegated'
    | 'smart-account'
    | 'unknown-counterfactual'
    | (string & Record<never, never>)
  /**
   * Capability-shaped batch support, normalized from the nested EIP-5792
   * `getCapabilities` shape (`caps[chainId].atomic.status`). Absent when the
   * wallet does not support `getCapabilities`. */
  batchExecution?: {
    atomic: 'supported' | 'ready' | 'unsupported' | (string & Record<never, never>)
  }
  /** Whether a paymaster/sponsorship is available (5792 `paymasterService`). */
  sponsorable: boolean
  /**
   * Can an adapter run the EFS routine IN this account's context (one-sig single
   * file)? A capability, not a vendor. `false` until in-account adapters land
   * (the deferred AA work). */
  canRunInAccountRoutine: boolean
  /** The raw `getCapabilities` blob, quarantined so the curated view never leaks
   * 5792 vocabulary and a future standard maps without a break. */
  raw?: unknown
}

/**
 * PUBLIC curated capability view — what `efs.account.capabilities()` returns
 * (sdk-wallet-architecture §Public surface). Answers the dev's actual question
 * (can this sign once? is it gasless?) with no internals: never `atomic:'ready'`
 * or an adapter id. */
export type AccountCapabilities = {
  kind: AccountProfile['kind']
  /** Can a single-file write land in ONE signature (an in-account routine)? */
  canOneSig: boolean
  /** Can a write run without the user paying gas (a relayer/paymaster)? */
  gasless: boolean
  /** Is a sponsor (paymaster/relayer) available for this account? */
  sponsored: boolean
}

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
   * account (lenses key on the attester — ADR-0013/0014). Reserved additively; the
   * Tier-1 path always attests as the wallet account, so a value OTHER than the
   * connected account is not yet honored and is REJECTED (`NotImplemented`) rather than
   * silently authored under the wallet lens — delegated/foreign-lens writes are a later
   * slice. Passing the connected account (or omitting this) is the supported path.
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
  /** The file's content-identity hash — present on a file write (`fs.write`).
   * ABSENT on the standalone edge/value writes (`graph.tags`/`props`/`graph.pins`),
   * which place/bind no content (additive — these primitives reuse the same receipt
   * shape but have no bytes to hash). */
  contentHash?: ContentHash
  data?: DataRef
  /** Every minted attestation in the write graph, keyed by step `id`. The `uid` is a
   * RAW attestation UID whose KIND is given by `id` (file-ANCHOR, MIRROR, PROPERTY,
   * placement-PIN, TAG, LIST_ENTRY, REDIRECT, DATA, …) — it is deliberately NOT a
   * {@link DataUID}: most steps are not file-content identities, so branding them
   * `DataUID` would let a placement/property/anchor UID be passed where a DATA UID is
   * required (the wrong-UID-kind bug the brands exist to catch). The file's content
   * identity is {@link WriteReceipt.data} (`data.uid: DataUID`), not a step. */
  steps: Array<{ id: string; uid?: Hex; done: boolean }>
  signatureCount: number
  mechanism: WriteMechanism
  /** Lifecycle status; `'partial'`/`'reverted'` flag a half-written file. */
  status?: CallStatus
  /** Whether the write ran without the user paying gas (a relayer/paymaster).
   * Always `false` on the Tier-1 path (the user pays). */
  gasless?: boolean
  /**
   * Honest + actionable provenance (sdk-wallet-architecture §Principles #6): the
   * mechanism the selector picked and WHY, so a UI can explain why it signed N
   * times. `selected` mirrors {@link WriteReceipt.mechanism}; `why` is a closed-ish
   * discriminant of the selection paths in the priority ladder. */
  reason?: {
    selected: WriteMechanism
    why:
      | 'in-account-routine'
      | 'no-in-account-adapter'
      | 'dependent-dag-needs-sequential'
      | 'fell-back-from-5792'
  }
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
export type ReadResult = {
  data: DataRef
  resolvedBy: Address
  /**
   * The REDIRECT alias chain followed to reach `data`, when `{ followRedirects }`
   * was set AND at least one hop was taken (ADR-0050). Each entry is one hop, in
   * traversal order (the first is the redirect on the originally-requested target,
   * the last lands on `data`). ABSENT when no redirect was followed — so the mere
   * presence of `via` signals "this was redirected", and `via[0].from` is the
   * originally-requested identity (`redirectedFrom`). Never silently teleport: a UI
   * should surface `via` (the asserting attester + the hop) per ADR-0050's
   * client-UX invariant.
   */
  via?: readonly RedirectRecord[]
}

// ── Lists (curated collections — ADR-0044/0046) ─────────────────────────────────

/**
 * The kind of target a LIST holds, denormalized from the LIST config's `uint8
 * targetType` (`IListReader.ListMode.targetType`; `ListReader.sol`):
 *   - `'any'`    (0) — opaque member keys (`bytes32`); use `targetAsMemberKey`.
 *   - `'addr'`   (1) — Ethereum addresses; use `targetAsAddress`.
 *   - `'schema'` (2) — attestation/anchor UIDs of one schema (`targetSchema`); use
 *     `targetAsUID`.
 * A literal union (not the raw `uint8`) so the value is self-describing on the DTO.
 */
export type ListTargetType = 'any' | 'addr' | 'schema'

/**
 * A LIST's configuration + identity — the `efs.lists.get` result, decoded from the
 * LIST attestation via `ListReader.getMode(listUID)` (schema-checked BEFORE decode,
 * so a non-LIST UID surfaces `exists:false` rather than a spoofed config). NOT
 * lens-scoped: the config is the curator's own declaration, read by UID. A plain
 * serializable DTO (matches the read-surface DTO rule).
 */
export type ListConfig = {
  /** The LIST UID this config describes (echoed for convenience). */
  listUID: Hex
  /** `false` when no LIST attestation exists at `listUID` (or it is the wrong
   * schema). Every other field is a zero/default value when `exists:false`. */
  exists: boolean
  /** The curator — the LIST attestation's `attester` (`ListMode.curator`). The
   * default lens for the entry reads (a single-curator list reads its own entries). */
  curator: Address
  /** Whether the same target may appear more than once (`allowsDuplicates`). When
   * `false`, {@link ListsNs.entries} dedupes by identity key (first occurrence wins). */
  allowsDuplicates: boolean
  /** Append-only (entries can never be revoked/removed) vs revocable. */
  appendOnly: boolean
  /** The target kind (`any`/`addr`/`schema`) the typed entry accessors key on. */
  targetType: ListTargetType
  /** For `targetType:'schema'`, the single schema UID every target must be; the
   * zero word otherwise. */
  targetSchema: Hex
  /** Cap on the number of entries (`0` = uncapped). */
  maxEntries: bigint
}

/**
 * One resolved LIST entry — an item of the `efs.lists.entries` page. The `target`
 * is decoded per the list's {@link ListTargetType}: an `Address` for `addr`, a UID
 * `Hex` for `schema`, or an opaque member-key `Hex` for `any` (the `targetKind`
 * field tells a consumer which). Plain serializable data; insertion order preserved.
 */
export type ListEntry = {
  /** The LIST_ENTRY attestation UID (the entry's own identity; revoke target). */
  entryUID: Hex
  /** Which flavor `target` is — mirrors the owning list's {@link ListTargetType}. */
  targetKind: ListTargetType
  /** The resolved target: an `Address` (`addr`), a UID (`schema`), or an opaque
   * member key (`any`). The on-chain `identityKey` for ADDR/ANY; the decoded UID for
   * SCHEMA. */
  target: Address | Hex
  /** The attester whose entry this is (the lens attester the entries were read for).
   * For a single-curator list this equals {@link ListConfig.curator}. */
  attester: Address
}

/** Options for the lens-scoped LIST entry reads (`entries`/`length`/`has`). */
export type ListReadOptions = {
  /** The lens to resolve the contributing attester through. A `Lens`, a raw
   * `Address` (literal lens), or omitted (defaults to the client `defaultLens`, then
   * the connected wallet, then the deployment SystemAccount — same ladder as the
   * file reads). The list entries are read for the FIRST resolved attester that has
   * any (first-attester-wins), mirroring how the on-chain reads key on one
   * `attester` and how file placement resolves first-wins. */
  lens?: Lens | Address
  /** Max entries per page (the SDK windows `ListReader.entries`). */
  limit?: number
  /** Opaque resumable cursor from a prior {@link Page}. */
  cursor?: string
}

/** Options for `efs.lists.get` — lens accepted for API symmetry, but the config is
 * read by UID (the LIST attestation), so the lens does not scope it. */
export type ListGetOptions = {
  /** Accepted for symmetry with the other list verbs; the config read is by-UID and
   * NOT lens-scoped (it decodes the curator's own LIST attestation). */
  lens?: Lens | Address
}

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
 * **Provenance + freshness of a read's ANSWER** — orthogonal to `verification`, which is the
 * authenticity of the BYTES (ADR-0015). `verification:'matches-author'` proves the bytes are
 * what the lens attester committed; `trust` says whether on-chain existence/revocation were
 * confirmed and how fresh that is. A cached read can be `matches-author` yet revoked — `trust`
 * is where that shows, so a cached read can never masquerade as a live one. (`trust` is the
 * freshness/provenance verdict; cryptographic authenticity is `verification`.)
 *
 * Modeled as a **discriminated union on `freshness`** (not a flat record) so the single
 * security-load-bearing axis has one name per state — the dangerous `'stale'` case (authentic
 * bytes, but existence + revocation UNKNOWN) is spelled `stale` and cannot hide behind a
 * reassuring sibling field, and incoherent combinations are unrepresentable. `asOf` is
 * structurally present only on the `'as-of'` variant. `source` reuses the
 * {@link ReadSourceCapabilities} `kind` vocabulary verbatim (one term per backend, SDK-wide).
 *
 * RESERVED (ADR-0015): exported now so the surface is stable; becomes a required field on the
 * rich read results (`EfsFile`/`FileInfo`/`ReadResult`) in the behavioral slice, where today
 * every source is live and verbs stamp `{ freshness:'current', source:'live' }`. Adding it
 * later would be a breaking change, so the shape lands ahead of the offline/indexer sources.
 */
export type TrustDescriptor =
  | {
      /** Chain-head read: existence + revocation are current NOW. The safe state. */
      freshness: 'current'
      source: 'live' | (string & Record<never, never>)
    }
  | {
      /** Bounded-stale: existence + revocation checked against a head at {@link asOf}. */
      freshness: 'as-of'
      source: 'snapshot' | 'indexer' | (string & Record<never, never>)
      /** Wall-clock head time (epoch seconds) the answer is current as of. Matches
       * {@link ReadSourceCapabilities.snapshotAsOf}'s width. */
      asOf: number
    }
  | {
      /** Content-only cache: bytes are authentic, but on-chain existence AND revocation are
       * UNKNOWN — the dangerous state, and the literal says so. */
      freshness: 'stale'
      source: 'snapshot' | (string & Record<never, never>)
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
