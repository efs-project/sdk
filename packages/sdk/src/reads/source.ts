/**
 * **`ReadSource`** — the seam that decouples "where a read comes from" from "a live viem
 * `PublicClient` bound to a chain at construction" (ADR-0014).
 *
 * Every EFS read funnels through one `readContract`-shaped operation (`reads/context.ts`
 * `read()`), so the source is deliberately THIN and generic — `readContract` plus optional
 * `getCode`/`getEnsAddress`/`getChainId` — not a set of semantic methods. The EFS on-chain
 * views already fold list/filter/range queries into `readContract` against frozen view
 * contracts, so the generic op is universal: a live source serves it by RPC, a snapshot by
 * lookup, an indexer by translating the known view functions internally. Semantic methods
 * (`getAttestation`/`queryBySchema`/`list`) would leak EFS protocol semantics (placement
 * resolution, lens-scoping, redirect-following) into the transport — which is the SDK's job,
 * not the source's.
 *
 * The chain is carried as **data** (`chainId`), present on every source kind, so deployment
 * resolution never depends on a live `publicClient.chain.id`. A live source additionally
 * exposes `getChainId()` for mutable-provider drift reflection; a snapshot/fixture has a
 * fixed `chainId` and no live probe.
 *
 * Reserved-and-additive: `ViemReadSource` (live) is the only implemented adapter today;
 * `SnapshotReadSource` (offline) and `IndexerReadSource` are documented stubs (see
 * `reads/sources/`). The interface is the stable boundary they plug into.
 */

import type { Abi, Address, Hex } from 'viem'

/**
 * The OBSERVED basis of a read's answer — result-carried evidence, not a claim
 * of authority (ADR-0014/0015 amendment). "A live hosted RPC is not itself proof
 * of current, complete, or authoritative state": the SDK never asserts
 * canonical-chain truth it cannot prove — a `'head'` source claims only that it
 * follows ITS BACKEND's head, and the basis records which head was observed.
 * Trust in the RPC/backend endpoint is the stated residual assumption, not
 * laundered through a boolean named "authoritative".
 */
export type ReadBasis = {
  /** The chain the answer was read against. */
  readonly chainId: number
  /** The block height observed (a snapshot's capture block; an indexer's
   * indexed head; optionally a live read's block). */
  readonly blockNumber?: bigint
  /** The block hash, when the backend can attest it (stronger than a height). */
  readonly blockHash?: Hex
  /** The finality tag the answer was served at. Open tail — new tags are additive. */
  readonly finality?: 'latest' | 'safe' | 'finalized' | (string & Record<never, never>)
  /** Wall-clock time (epoch seconds) the answer is current as of. */
  readonly asOf?: number
}

/**
 * What a {@link ReadSource} can answer — so verbs/callers branch BEFORE issuing a read
 * rather than discovering a gap via a thrown error mid-resolution. The discriminant `kind`
 * has an open tail so a new backend is additive (mirrors the `WriteMechanism`/transport-name
 * pattern elsewhere in the SDK). Every flag is OBJECTIVE (what the backend structurally
 * does), never a subjective authority claim — see {@link ReadBasis}.
 */
export interface ReadSourceCapabilities {
  /** Backend discriminant. `'live'` = an RPC node; `'snapshot'` = prefetched records, no
   * node; `'indexer'` = a GraphQL/SQL backend; `'fixture'` = test data. */
  readonly kind: 'live' | 'snapshot' | 'indexer' | 'fixture' | (string & Record<never, never>)
  /**
   * The backend's structural relationship to chain head — the objective axis the
   * trust descriptor's `freshness` derives from (replacing the subjective
   * `authoritative: boolean`):
   *   - `'head'`    — follows its backend's chain head this session (an RPC node).
   *     Existence/revocation answers are current AS THE BACKEND SEES THEM
   *     (freshness `'current'`; the endpoint itself is the residual trust).
   *   - `'lagging'` — follows a head that trails the chain (an indexer tailing
   *     blocks). Answers are `'as-of'` its indexed head, never `'current'`.
   *   - `'pinned'`  — a fixed capture (snapshot/fixture). Answers are `'as-of'`
   *     the {@link pinnedBasis} when one is recorded, else `'stale'` (content
   *     only — existence/revocation unknown).
   */
  readonly state: 'head' | 'lagging' | 'pinned' | (string & Record<never, never>)
  /** For a `'pinned'` source: the capture's observed basis (block/asOf) — what a
   * cached read stamps so it can never masquerade as live. */
  readonly pinnedBasis?: ReadBasis
  /** Can it serve `getCode` (web3:// SSTORE2 reads, bytecode integrity, account detection)?
   * A snapshot keyed only by UID generally cannot. Describes CALLABLE behavior —
   * never stored-data presence a lookup can't yet serve. */
  readonly supportsGetCode: boolean
  /** Can it serve `getEnsAddress` (ENS-lens resolution)? Callable behavior only. */
  readonly supportsEns: boolean
  /** `'arbitrary'` = a real node answering any `(address, fn)`; `'known-subset'` = a snapshot
   * (only captured calls) or an indexer (only the view fns it translates). */
  readonly readContract: 'arbitrary' | 'known-subset'
  /** Range/filter directory reads (`getDirectoryPage*`). A point-only snapshot keyed by UID
   * cannot page a directory it did not capture; an indexer is RICHER here than a node. Lets a
   * future `fs.list` pick a source by query shape. */
  readonly supportsRangeQueries: boolean
}

/**
 * The minimal operation set ALL read paths funnel through (ADR-0014). A superset of the
 * narrow `ReadPublicClient` (`reads/context.ts`), so a `ReadSource` is structurally usable
 * everywhere a `ReadPublicClient` is today — the migration is a retype, not a rewrite.
 */
export interface ReadSource {
  /** The universal read — same shape as `ReadPublicClient.readContract`. A non-arbitrary
   * source throws `ReadUnsupported` (later slice) for a call it cannot serve. */
  readContract(args: {
    address: Address
    abi: Abi
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
  /** Bytecode read (web3:// SSTORE2 + account detection). Absent ⇒ `supportsGetCode:false`
   * and the web3:// reader is simply not wired (the fetch engine already guards on this). */
  getCode?(args: { address: Address }): Promise<Hex | undefined>
  /** ENS resolution for ENS-lenses. Absent ⇒ `supportsEns:false`. */
  getEnsAddress?(args: { name: string }): Promise<Address | null>
  /** The LIVE chain id — present only on a live source (mutable-provider drift reflection).
   * A snapshot/fixture omits it and serves its fixed {@link ReadSource.chainId}. */
  getChainId?(): Promise<number>
  /** The deployment chain this source serves, as DATA — present on every source kind, so
   * deployment resolution never needs a live `publicClient.chain.id`. */
  readonly chainId: number
  /** What this source can answer (so callers branch instead of catching). */
  readonly capabilities: ReadSourceCapabilities
}
