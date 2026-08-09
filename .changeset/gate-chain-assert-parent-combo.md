---
"@efs/sdk": patch
---

Two hardening completions: (1) `submitLayeredTier1` asserts the LIVE chain before running the boundary validation gates — their EAS/indexer reads go through the unguarded submit client, so a mutable provider could previously serve another chain's attestation/anchor state to the gates, switch back, and pass the per-layer broadcast assertion with foreign proofs; only plans carrying a gate stamp pay the extra assertion. (2) `buildFileWriteGraph` rejects the documented-invalid `missingParents` + `existingFileAnchorUID` combination up front — a brand-new parent cannot already hold the file's anchor slot, and the slot stamps compare against the deepest EXISTING ancestor in that mode, so an existing sibling's anchor could pass validation while the requested path ended up with no file.
