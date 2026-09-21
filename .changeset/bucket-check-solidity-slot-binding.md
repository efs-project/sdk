---
"@efs/sdk": patch
"@efs/solidity": patch
---

The placement-gate matrix completes: (1) the DATA-bucket check is now UNCONDITIONAL in the TS gates — the layered boundary and `pins.place` decode every placement anchor's `(name, forSchema)` payload and refuse anchors outside the DATA file bucket even on standalone plans with no requested slot (a generic-folder or PROPERTY-key ANCHOR passed the schema check but file resolution only discovers DATA-bucket terminals). (2) Solidity `writeFile` and the six-argument `placeExisting` bind reused anchors to the requested `(parent, fileName, DATA)` slot via the shared `_requireAnchorNamesSlot` (reverting the new `AnchorSlotMismatch`), and the standalone `place` enforces the DATA bucket (`NotFileBucketAnchor`) — a valid ANCHOR from another slot previously let the transaction and `EFSFileWritten` confirm while a different path was overwritten or nothing discoverable was placed.
