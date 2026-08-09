---
"@efs/sdk": patch
"@efs/solidity": patch
---

Fix three review findings around list materialization caps and the Solidity property
update path:

- **`efs.lists.entries(uid).toArray({ limit })` now validates the limit** with the same
  finite-positive-integer guard the constructor and `byPage` use. A fractional limit
  (`1.5`) used to over-collect (the `>= limit` break fired one entry late) and `Infinity`
  paged until the list was exhausted, defeating the mandatory materialization cap.

- **`efs.fs.list(path).toArray({ limit })` now rejects non-finite/non-positive/non-integer
  limits** before paging. Previously `Infinity` made `remaining` infinite and
  `Math.min(defaultLimit, remaining)` collapsed to a normal page size, silently
  materializing the entire directory despite `toArray` being documented as requiring a
  bounded cap.

- **`@efs/solidity` `EFSWriter` gains `_efsSetPropertyAt`** for property *updates*.
  `_efsSetProperty` always mints a fresh key-ANCHOR, so calling it twice for the same
  `(dataUID, keyName)` reverts on the permanent duplicate anchor rather than superseding.
  The new wrapper exposes `EFSLib.setPropertyAt` (mints only the PROPERTY + binding-PIN
  against a pre-resolved key-ANCHOR, cardinality-1 supersede); the `_efsSetProperty`
  docstring now states it is the first-set/create form and points updates at the new
  helper (mirroring the TypeScript `props.set`, which resolves and reuses the anchor).
