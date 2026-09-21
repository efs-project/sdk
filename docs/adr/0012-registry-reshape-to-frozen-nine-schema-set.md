# ADR-0012: Reshape the deployments registry to the frozen 9-schema set

**Status:** Accepted
**Date:** 2026-06-18
**Related:** ADR-0005 (registry), contracts `docs/SEPOLIA_FREEZE_TABLE.md`, contracts ADR-0048/0049/0050/0052/0053

## Context

ADR-0005 ships a per-chain registry whose `EfsContracts` / `EfsSchemaUIDs` key sets mirror the contracts repo. An earlier reconciliation (pre-freeze) keyed those types off a `deployedContracts.ts` snapshot: schemas included `blob`, `naming`, and `sortInfo`; contracts included `sortOverlay` (EFSSortOverlay) and `schemaNameIndex` (SchemaNameIndex); there was no `redirect` schema and no `aliasResolver`. That snapshot is now stale.

The Sepolia freeze (contracts `docs/SEPOLIA_FREEZE_TABLE.md`, the human sign-off gate per ADR-0048) defines the canonical set as **exactly 9 schemas**: ANCHOR, PROPERTY, DATA, PIN, TAG, MIRROR, LIST, LIST_ENTRY, REDIRECT. DATA is reshaped to pure identity (empty schema, ADR-0049); PROPERTY is non-revocable (ADR-0052); REDIRECT is a new first-class primitive owned by a standalone `AliasResolver` (ADR-0050). BLOB and NAMING were dropped; SORT_INFO (and its EFSSortOverlay) is deferred — addable later without orphaning, so it is not in the frozen set. A new `SystemAccount` relay (ADR-0053) deploys alongside the resolvers.

## Decision

Reshape the registry static surface to the frozen set. This **supersedes the registry portion of ADR-0005's earlier reconciliation** (the part that added `blob`/`naming`/`sortInfo` and omitted `redirect`/`aliasResolver`); the rest of ADR-0005 (the SDK-is-a-client model) stands.

- `EfsSchemaUIDs`: drop `blob`, `naming`, `sortInfo`; add `redirect`. Final 9 keys: `anchor`, `property`, `data`, `pin`, `tag`, `mirror`, `list`, `listEntry`, `redirect`.
- `EfsContracts`: drop `sortOverlay`, `schemaNameIndex`; add `aliasResolver` and `systemAccount`. The freeze table is now the source of truth (not `deployedContracts.ts`).
- Add `EFS_SCHEMA_FIELDS` (`src/eas/schemas.ts`): the single source of truth for the 9 frozen, byte-identical field strings, for `SchemaEncoder` construction and UID derivation. DATA = `''`.
- The built-in `deployments` map stays **empty**: UIDs and addresses are deploy-derived (atomic CREATE3 deploy + register-last), TBD until the Sepolia deploy. Nothing is seeded from a stale snapshot.
- Per-schema UID sources (for the read-layer assertion, not yet wired): anchor/property/data/pin/tag/mirror from the Indexer getters; list from ListResolver; **listEntry** from ListEntryResolver and **redirect** from `AliasResolver.redirectSchemaUID()` — both self-derived, with no Indexer getter.

## Consequences

- The SDK's static types now match the freeze; a consumer-supplied `deployments` override must use the 9-key shape. Pre-1.0, this break is acceptable.
- The schema-UID integrity assertion (ADR-0005) must read from three sources, not just the Indexer — recorded in the registry TODO so the read layer wires it correctly.
- `EFS_SCHEMA_FIELDS` makes UID drift a single-file concern: re-freezing the contracts table is mirrored here (via supersession) and nowhere else.
- No chain access, ABI vendoring, or `fs.*` implementation here — pure static-surface correction (P1 of the freeze-reconcile plan).

## Alternatives considered

- **Seed the registry from `deployedContracts.ts`** — rejected: that snapshot predates the freeze (wrong schema set, no AliasResolver) and UIDs/addresses are deploy-derived anyway. The map stays empty until the real deploy.
- **Edit ADR-0005 in place** — rejected: ADRs supersede, never edit (README discipline). ADR-0005's client model is untouched; only the registry shape it described is replaced.
- **Keep `sortInfo` as a placeholder for the deferred SORT_INFO** — rejected: it is not in the frozen set; carrying a key for an unregistered schema invites a wrong UID assertion. Add it when SORT_INFO is actually frozen.
