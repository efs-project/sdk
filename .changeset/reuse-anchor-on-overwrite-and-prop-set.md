---
"@efs/sdk": patch
---

Fix two write-path correctness bugs where the SDK re-minted a permanent, non-revocable ANCHOR for a slot that already existed — reverting (`DuplicateFileName`) or mis-binding instead of superseding via the cardinality-1 PIN.

- **Overwrite reuses the file anchor (Bug 1).** `efs.fs.write` / `efs.fs.setOverview` to a path whose DATA-typed file anchor already exists no longer mints a fresh file-ANCHOR for the same `(parent, fileName, schemas.data)` slot. `writeFileTier1` now probes for the existing anchor (`resolveAnchor(parentAnchorUID, fileName, schemas.data)`, only when the parent already exists — a `mkdir -p` leaf can't pre-exist) and threads an optional `existingFileAnchorUID` into `buildFileWriteGraph`. When present the graph emits NO file-ANCHOR and points the placement PIN's `definition` (and any Overview `system` TAG's `refUID`) at the concrete existing UID; when absent it mints the DATA-typed file anchor exactly as before. The cardinality-1 placement PIN supersedes the prior content. The reserved-key triples + DATA + MIRRORs are still minted fresh (new content). A second `setOverview` on the same folder now succeeds.

- **`props.set` reuses the key anchor (Bug 2).** `efs.props.set(dataUID, key, value)` on an existing key no longer mints another key-ANCHOR for `(dataUID, key, PROPERTY_SCHEMA_UID)`. `set` resolves the existing key anchor first (`resolveAnchor`); when it exists, `buildPropertyPlan` builds only the fresh PROPERTY + a binding-PIN whose `definition` is the concrete existing key-anchor (mirroring Solidity `EFSLib.setPropertyAt`), so the read path (`resolveAnchor(dataUID, key, PROPERTY_SCHEMA_UID)`) sees the updated value. A new key still emits the full key-ANCHOR + PROPERTY + binding-PIN triple.

Encodings are unchanged (verified against the deployed contracts); only standalone `props.set` and the file-ANCHOR overwrite gained the reuse logic. No public API changes; no bundle-size-relevant hot-path additions.
