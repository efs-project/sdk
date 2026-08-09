---
"@efs/sdk": patch
"@efs/solidity": patch
---

Reused concrete file-ANCHORs are now validated before broadcast: (1) the builder stamps plans with `anchorSchemaUID` + `existingAnchorUID` when an overwrite/relink reuses a concrete anchor, and `submitLayeredTier1` verifies the reused definition IS an ANCHOR attestation (fail-closed on a missing stamp or a read-incapable context) — an arbitrary `existingFileAnchorUID` executed through the exported layered submitter previously skipped the anchor mint and could confirm a placement `fs.*` can never discover. (2) Solidity's six-argument `placeExisting` applies the same `NotAnchorUID` check to a nonzero reused anchor before attesting the PIN. For `fs.write` (which resolves the UID via `resolveAnchor` — an ANCHOR by construction) this is one extra defense-in-depth read per overwrite.
