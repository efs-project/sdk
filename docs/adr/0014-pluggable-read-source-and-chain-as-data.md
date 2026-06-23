# ADR-0014: Pluggable read source; the chain bound as data

**Status:** Proposed
**Date:** 2026-06-23
**Related:** PR #1, ADR-0005 (deployments registry), ADR-0009 (library-agnostic seam), ADR-0015 (read trust provenance), planning/Designs/sdk-architecture.md, planning/Designs/sdk-pluggable-read-source.md (to be written — the cross-repo offline-client slice)

## Context

Today every SDK read funnels through a single helper (`reads/context.ts` `read()`) over a
narrow `ReadPublicClient` interface, but the client is **always a live viem `PublicClient`
bound to a chain at construction**. Two foundational uses break against that assumption:

- **Offline / local-first** — the production client is getting an offline mode that reads
  *cached* attestations and file bytes with no node and no live chain. EAS UIDs are
  content-derived and attestations are signed, so the SDK can verify cached **content**
  with zero RPC — but the read path has no way to *come from* anywhere but a live node.
- **Chainless / chain-as-data** — a viem client built from a bare transport
  (`createPublicClient({ transport })`) answers `getChainId()` but exposes no synchronous
  `chain.id`. The write/raw/eas paths resolve the deployment synchronously from
  `publicClient.chain.id`, so a chainless client throws on first use even on a supported
  chain. (PR #1 currently rejects chainless clients at construction as a stopgap — this
  ADR supersedes that.)

The same seam also serves indexer-backed reads at scale, test fixtures, and Ring-3
sandboxed apps (which broker reads through a host proxy, never a direct node). Three
independent design passes converged on one conclusion: **"where a read comes from" must be
an interface the read logic depends on, not a hardcoded live viem client.** Getting this
wrong now is an expensive retrofit (every read verb threads the client); getting the
*shape* right now makes the offline/indexer impls purely additive.

The recurring cross-chain-drift review findings on PR #1 (≈9 waves of "re-check the chain
before this read/wait too") are the same root cause surfacing as a hazard: a *mutable
provider whose chain can drift under synchronous reads*. Binding the chain as **data** on
the source — rather than sniffing it live from a drifting provider — is what structurally
retires that whole class.

## Decision

Introduce a **`ReadSource`** seam: a thin, generic interface that all read paths funnel
through, plus a `capabilities` descriptor so verbs/callers branch on what a source can
answer rather than discovering gaps via thrown errors.

```ts
interface ReadSourceCapabilities {
  kind: 'live' | 'snapshot' | 'indexer' | 'fixture' | (string & Record<never, never>)
  authoritative: boolean      // read CURRENT chain state this session? (existence/revocation observable)
  supportsGetCode: boolean    // web3:// SSTORE2 + bytecode integrity + account detection
  supportsEns: boolean        // ENS-lens resolution
  readContract: 'arbitrary' | 'known-subset'
  supportsRangeQueries: boolean  // directory/list/range reads (an indexer is richer here than a node)
  snapshotBlock?: bigint
  snapshotAsOf?: number
}

interface ReadSource {
  readContract(args): Promise<unknown>     // the universal op — same shape as ReadPublicClient today
  getCode?(args): Promise<Hex | undefined> // optional
  getEnsAddress?(args): Promise<Address | null> // optional
  getChainId?(): Promise<number>           // live sources only; snapshots carry a fixed chainId
  readonly chainId: number                 // the deployment chain as DATA
  readonly capabilities: ReadSourceCapabilities
}
```

**Thin/generic, not semantic.** The interface is `readContract` (+ optional
`getCode`/`getEnsAddress`/`getChainId`), *not* semantic methods (`getAttestation`,
`queryBySchema`, `list`). The EFS on-chain views already fold list/filter/range into
`readContract` against frozen view contracts, so the generic op is universal: a live source
serves it by RPC, a snapshot by lookup, an indexer by translating the ~12 known view
functions internally. Semantic methods would leak EFS protocol semantics (placement
resolution, lens-scoping, redirect-following) into the transport — which is the SDK's job,
not the source's — and would force rewriting the six existing narrow client interfaces.

**Chain bound as data.** `ReadSource.chainId` is data, present on every source kind.
Deployment resolution reads `source.chainId` synchronously (works for live, snapshot,
indexer, fixture); the live source additionally re-resolves via `getChainId()` for
mutable-provider drift reflection on reads. This **supersedes the chainless-client
rejection**: a read-only client over any source resolves fine; only a *write-capable* live
client still requires a synchronously-known chain anchor (writes validate against it).

**Coexistence with the write/cross-chain invariant.** The prior cross-chain hardening
(`assertWriteChain`, the guarded proxies) is entirely write-side and live-source-side and
stays as-is. A snapshot/indexer source is read-only by construction (no wallet), so the
write guards are never reached, and its single fixed `chainId` is the *only* chain — there
is nothing to drift against. So chain-as-data and "writes validate against a
synchronously-known deployment chain" partition cleanly rather than conflict.

**Adapters:** `ViemReadSource` (wraps a `PublicClient`; today's behavior, the only live
impl) ships now. `SnapshotReadSource` (prefetched records keyed by call, no node) and
`IndexerReadSource` (translates view fns to GraphQL/SQL) are **documented stubs that throw
`NotImplemented`** now and graduate additively. Consistent with the standing "no bundled
indexer; a caller-supplied source, not an `index?` config" stance.

**Reserved injection seams (Fork 2).** Reserve — shape only, not yet honored — an optional
`fetch` and a signature `verifier` on the client config, so Ring-3 sandboxed apps
(no `globalThis.fetch`/`crypto`) and non-ECDSA firmware verticals are additive later, and
future agents see the seam instead of hardcoding around it. Passing either today throws
`NotImplemented` (an explicit "reserved" signal, never a silent no-op).

## Consequences

- **Foundational seam reserved at low cost.** Reads already funnel through one helper, so
  formalizing `ReadSource` is largely a retype + adapter, not a rewrite. Offline, indexer,
  fixture, and Ring-3 read sources become additive `ReadSource` impls behind a stable
  interface instead of forks of the read path.
- **Chainless clients work**, and the confusing-on-first-write `DeploymentNotFound` is
  replaced by chain-as-data. The PR #1 chainless-rejection stopgap is superseded; the
  rejection now applies only to write-capable live clients with no chain anchor.
- **Retires the drift class.** Once reads depend on a source that owns its chain identity,
  "the provider drifted between read A and read B" stops being expressible — the
  per-call-site `assertChain` apparatus collapses into the source boundary over time.
- **Phasing.** Foundational interfaces + adapters + chainless construction land in PR #1;
  the snapshot serializer/recorder and the real indexer translation are additive later
  with no breaking change. Pre-1.0, so the internal `ReadContext.publicClient → source`
  rename is free; the published-surface commitment (the trust descriptor) is ADR-0015.
- **Open follow-ups:** point-vs-list source routing (a composable `routingReadSource`,
  deferred), `verifyDeployment` over a non-authoritative source (throws `ReadUnsupported`),
  and ENS-lens over an offline source (requires an ENS-capable source or a pre-resolved
  address lens). A planning-vault design captures the cross-repo offline-client slice.

## Alternatives considered

- **Semantic `ReadSource` (`getAttestation`/`list`/`queryBySchema`).** Indexer-friendly but
  leaks EFS protocol semantics into the transport and forces rewriting every verb + the six
  narrow interfaces. Rejected — the generic `readContract` is already universal.
- **Make `getDeployment` async/live everywhere.** Would collapse the deliberate
  "reads re-resolve live, writes validate against a fixed construction chain" split and let
  a public client drift the write plan independently of the wallet. Rejected.
- **Reject chainless clients permanently (the PR #1 stopgap).** Simple, but cuts off
  offline/fixture/Ring-3 read-only clients that have a perfectly good fixed chainId as data.
  Rejected in favor of chain-as-data.
