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

/** How to resolve a read: a `Lens`, a raw address (treated as a literal lens),
 * or omitted (defaults to the connected wallet). */
export type ReadOptions = {
  /** The lens to resolve through. */
  lens?: Lens | Address
}

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
   * Inject a `fetch` implementation for byte retrieval (the off-chain engine
   * defaults to the global `fetch`). Escape hatch for callers that must control
   * egress at the transport level — a custom undici `Agent` (self-signed certs,
   * pinned DNS), a test stub, or a dev proxy. Most callers leave this unset.
   */
  fetchImpl?: typeof fetch
}

// ── Pagination ─────────────────────────────────────────────────────────────────

/** One page of a listing plus the cursor to resume after it. */
export type Page<T> = {
  items: readonly T[]
  /** Cursor for the next page, or `undefined` at the end. */
  nextCursor?: string
}

/** An async-iterable read that can also be paged explicitly. `for await` walks
 * every entry; `.page(opts)` fetches one bounded page + a resume cursor. */
export type EfsList<T> = AsyncIterable<T> & {
  page(opts?: { limit?: number; cursor?: string }): Promise<Page<T>>
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
 * an abandoned sequential run returns a success-shaped receipt. */
export type CallStatus = 'pending' | 'confirmed' | 'offchain-failed' | 'reverted' | 'partial'

export type WriteOptions = {
  contentType?: string
  onProgress?: (p: { step: number; total: number; phase: string }) => void
  resume?: WriteReceipt
  signal?: AbortSignal
  /**
   * Retrieval URIs where the bytes live (one MIRROR per entry). When supplied,
   * the SDK does NOT inline the content — it publishes these as the file's
   * mirrors. The URI scheme of the FIRST entry selects the transport definition
   * (the on-chain `/transports/<scheme>` anchor) unless `transportDefinition` is
   * given. Omit to fall back to a self-contained inline `data:` URI (guarded by a
   * size cap — large content must supply `mirrors`).
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
 * kind of operation failed (review A6). */
export type OperationKind = 'write' | 'pin' | 'tag' | 'property' | 'list' | 'mirror' | 'sort'

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

/** A resolved read: the data ref plus which attester/lens won (review UX-4).
 * `resolvedBy` is also folded into `DataRef` (review A2) so a ref carried to
 * `fetch` alone can still verify; it is kept here for the read-time view. */
export type ReadResult = { data: DataRef; resolvedBy: Address }

/** Fetched bytes + trust-relative verification (never a bare "verified"). */
export type EfsFile = {
  bytes: Uint8Array
  contentType?: string
  verification: VerificationStatus
  /** Whose contentHash claim was checked against. */
  hashAuthor?: Address
}

/** Metadata about the file at a path, without fetching bytes. Discriminated on
 * `exists` (review A7): absence is modeled once here, not also as a `| null`
 * return. Mirrors the Solidity `(bool exists, …)` shape. */
export type FileStat =
  | { exists: false }
  | {
      exists: true
      data: DataRef
      resolvedBy: Address
      contentType?: string
      size?: bigint
    }

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
