/** Public value + option shapes. Branded UID kinds because wrong-UID-kind is the
 * dominant integration bug (review DX-13). Static `DataRef` vs dynamic `PathRef`
 * never silently interconvert (sdk-architecture §5). Option/return types are
 * NAMED and exported so adding a field later is non-breaking (review C1). */

import type { Address, Hex } from 'viem'
import type { VerificationStatus } from './content/hash.js'
import type { Lens } from './lenses/resolve.js'

// ── Branded references ─────────────────────────────────────────────────────────

export type DataUID = Hex & { readonly __kind: 'DataUID' }

/** Static reference — these exact bytes / this version. */
export type DataRef = { readonly __brand: 'DataRef'; readonly uid: DataUID }
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
}

export type FetchOptions = {
  /** Verify fetched bytes against the author's attested contentHash (default true). */
  verify?: boolean
  /** Restrict/prioritize transports (e.g. `['ipfs', 'https']`); default = all by priority. */
  transports?: readonly string[]
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

// ── Writes ─────────────────────────────────────────────────────────────────────

/** How a batched write was delivered. Exported so additions are localized, not a
 * breaking change to an exhaustive `switch` (review C5). */
export type WriteMechanism = 'multiAttest-sequential' | 'eip5792' | 'erc4337' | 'gateway'

export type WriteOptions = {
  contentType?: string
  onProgress?: (p: { step: number; total: number; phase: string }) => void
  resume?: WriteReceipt
  signal?: AbortSignal
}

/** A durable, serializable write session. `steps` are idempotent per
 * (path-qualified) id so a resume skips only mined work and never double-mints. */
export type WriteReceipt = {
  contentHash: string
  data?: DataRef
  steps: Array<{ id: string; uid?: DataUID; done: boolean }>
  signatureCount: number
  mechanism: WriteMechanism
}

/** One operation's result inside a multi-op batch. */
export type OperationResult = {
  id: string
  ok: boolean
  uid?: DataUID
  error?: Error
}

/** The result of executing a multi-op batch. */
export type BatchReceipt = {
  results: readonly OperationResult[]
  signatureCount: number
  mechanism: WriteMechanism
}

export type WriteEstimate = {
  attestations: number
  transactions: number
  signatureCount: number
  chunkDeploys: number
  gas: bigint
  estimatedUSD?: number
  warnings: string[]
}

// ── Reads ──────────────────────────────────────────────────────────────────────

/** A resolved read: the data ref plus which attester/lens won (review UX-4). */
export type ReadResult = { data: DataRef; resolvedBy: Address }

/** Fetched bytes + trust-relative verification (never a bare "verified"). */
export type EfsFile = {
  bytes: Uint8Array
  contentType?: string
  verification: VerificationStatus
  /** Whose contentHash claim was checked against. */
  hashAuthor?: Address
}

/** Metadata about the file at a path, without fetching bytes. */
export type FileStat = {
  exists: boolean
  data?: DataRef
  resolvedBy?: Address
  contentType?: string
  size?: bigint
}
