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
 * What a {@link ReadSource} can answer — so verbs/callers branch BEFORE issuing a read
 * rather than discovering a gap via a thrown error mid-resolution. The discriminant `kind`
 * has an open tail so a new backend is additive (mirrors the `WriteMechanism`/transport-name
 * pattern elsewhere in the SDK).
 */
export interface ReadSourceCapabilities {
  /** Backend discriminant. `'live'` = an RPC node; `'snapshot'` = prefetched records, no
   * node; `'indexer'` = a GraphQL/SQL backend; `'fixture'` = test data. */
  readonly kind: 'live' | 'snapshot' | 'indexer' | 'fixture' | (string & Record<never, never>)
  /** Did this source read CURRENT chain state this session? `true` ⇒ on-chain EXISTENCE and
   * REVOCATION are observable (a live node). `false` ⇒ frozen/prefetched data: revocation
   * and existence cannot be re-derived, only UID self-consistency + content-hash (ADR-0015).
   * This is the load-bearing flag the trust descriptor stamps from. */
  readonly authoritative: boolean
  /** Can it serve `getCode` (web3:// SSTORE2 reads, bytecode integrity, account detection)?
   * A snapshot keyed only by UID generally cannot. */
  readonly supportsGetCode: boolean
  /** Can it serve `getEnsAddress` (ENS-lens resolution)? */
  readonly supportsEns: boolean
  /** `'arbitrary'` = a real node answering any `(address, fn)`; `'known-subset'` = a snapshot
   * (only captured calls) or an indexer (only the view fns it translates). */
  readonly readContract: 'arbitrary' | 'known-subset'
  /** Range/filter directory reads (`getDirectoryPage*`). A point-only snapshot keyed by UID
   * cannot page a directory it did not capture; an indexer is RICHER here than a node. Lets a
   * future `fs.list` pick a source by query shape. */
  readonly supportsRangeQueries: boolean
  /** When NOT authoritative: the block the data was captured at — the provenance a cached
   * read stamps so revocation freshness reads `as-of <block>` instead of masquerading live. */
  readonly snapshotBlock?: bigint
  /** When NOT authoritative: the wall-clock capture time (epoch seconds). */
  readonly snapshotAsOf?: number
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
