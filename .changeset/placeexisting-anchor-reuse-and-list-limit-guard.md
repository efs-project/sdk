---
"@efs/sdk": patch
"@efs/solidity": patch
---

Two fixes from review:

- **`@efs/solidity` `EFSLib.placeExisting` / `EFSWriter._efsPlaceExisting` gain an
  `existingFileAnchorUID` reuse overload.** The 5-arg/4-arg forms always mint the
  `(parent, name, DATA)` file-ANCHOR, so re-pointing an EXISTING path reverted on the
  permanent duplicate anchor (or filed a non-canonical anchor the read path never finds).
  The new 6-arg/5-arg overload reuses a pre-resolved anchor and emits only the
  cardinality-1 placement PIN (supersede-in-place) — mirroring `writeFile`'s
  `existingFileAnchorUID` and the TypeScript hardlink branch. Resolve the slot first via
  `EFSReader.resolveAnchor(parent, name, schemas.data)` (zero ⇒ new path → mints).

- **`efs.fs.list(path, { limit })` now rejects a fractional/NaN/Infinity default limit**
  with the typed `InvalidDirectoryQuery` at construction (via `validateDirectoryQuery`)
  instead of throwing a raw `RangeError` at `BigInt(pageSize)` on the first page. Aligns
  the constructor/default-limit guard with `byPage`/`toArray`.
