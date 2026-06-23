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
- **`TrustDescriptor`** — the reserved read-provenance shape (`source`/`existence`/`revocation`)
  that becomes a required field on the rich read results in the behavioral slice.
- **Reserved client-config slots** `fetch` and `verifier` (a `SignatureVerifier` seam for
  non-ECDSA / Ring-3 brokered crypto). Not yet honored — passing either throws `NotImplemented`
  (an explicit reserved signal, never a silent no-op).

The `ReadContext` rename, wiring `ViemReadSource` into the read path, stamping `trust` on the
result types, and chainless (`SourceConfig`) construction are the behavioral phases, gated on
the ADR review.
