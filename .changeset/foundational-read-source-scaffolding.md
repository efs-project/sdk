---
"@efs/sdk": minor
---

Foundational read-architecture scaffolding (ADR-0014, ADR-0015) — additive, no behavior
change yet. Reserves the seams that future runtimes plug into so offline/indexer/Ring-3
support lands additively rather than as a breaking retrofit:

- **`ReadSource`** interface + `ReadSourceCapabilities` — the thin, generic seam reads will
  funnel through (decouples reads from a live chain-bound viem client). `ViemReadSource` is
  the live adapter (chain carried as DATA); `SnapshotReadSource` (offline) and
  `IndexerReadSource` are documented stubs with honest capabilities that throw `NotImplemented`
  on read.
- **`TrustDescriptor`** — the read-provenance shape: a discriminated union on `freshness`
  (`'current'` = chain-head; `'as-of'` = bounded-stale, carrying an `asOf` timestamp + the
  observed `ReadBasis`; `'stale'` = content-only cache where on-chain existence/revocation
  are UNKNOWN), each variant carrying a `source` drawn from the `ReadSourceCapabilities.kind`
  vocabulary. Now a REQUIRED `trust` field on the rich read results (`EfsFile`/`FileInfo`/
  `ReadResult`) — see the trust-provenance changeset.
- **Reserved client-config slots** `fetch` and `verifier` (a `SignatureVerifier` seam for
  non-ECDSA / Ring-3 brokered crypto). Not yet honored — passing either throws `NotImplemented`
  (an explicit reserved signal, never a silent no-op).

The `ReadContext` rename, wiring `ViemReadSource` into the read path, and chainless
(`SourceConfig`) construction are the remaining behavioral phases (ADR-0014's amended
phasing); the `trust` stamping has landed (ADR-0015 Accepted).
