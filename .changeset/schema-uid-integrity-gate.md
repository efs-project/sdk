---
"@efs/sdk": patch
---

Implement the schema-UID integrity assertion — the deployment trust gate that was a TODO and a flagged 1.0 blocker (review P1 #9, ADR-0005).

`assertDeploymentIntegrity` only checked that each contract address has *some* bytecode, so a wrong/hostile `deployments` override passed as long as the addresses were contracts — the read model's trust root was unverified. Now there is a real gate:

- **`assertSchemaIntegrity(publicClient, deployment)`** reads each of the nine frozen schema UIDs from its **authoritative** on-chain getter and asserts it matches `deployment.schemas`. Sources (ADR-0048): `anchor`/`property`/`data`/`pin`/`tag`/`mirror` → `Indexer.*_SCHEMA_UID()`; `list` → `ListResolver.listSchemaUID()`; `listEntry` → `ListEntryResolver.listEntrySchemaUID()`; `redirect` → `AliasResolver.redirectSchemaUID()` — the three self-derived UIDs hash in their own resolver's address, so a hostile contract set can't forge them. The nine reads are batched via `Promise.all` (one `eth_call` each; viem folds them into a multicall where supported). On any mismatch it throws `SchemaMismatchError` with a precise diff (which schema, claimed vs on-chain UID, source getter), listing every mismatch — not just the first. UID comparison is value-based (tolerant of casing + leading-zero width).
- **`verifyDeployment(publicClient, deployment)`** chains both gates: bytecode presence first (clearer error for a typo'd address), then schema authenticity.
- **`efs.raw.verifyDeployment()`** now runs the full `verifyDeployment` gate. It stays **opt-in** (ADR-0005): the client does not run it on every construct (no mandatory RPC round-trip), and callers wiring a custom `deployments` override are advised to run it once.

New exports: `assertSchemaIntegrity`, `verifyDeployment`.
