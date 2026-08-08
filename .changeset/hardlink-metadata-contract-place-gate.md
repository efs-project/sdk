---
"@efs/sdk": patch
"@efs/solidity": patch
---

The foreign-hardlink family closes out: (1) `buildFileWriteGraph`'s input is now a discriminated union — `FileWriteHardlinkInput` carries NO retrieval metadata by design (the reserved key-ANCHORs are canonical attester-independent PERMANENT slots, so a pure builder re-emitting the triplets for any previously-written DATA would revert the whole layer), and the hardlink branch REJECTS stray metadata at runtime with guidance instead of silently discarding it: the placer must already have authored the DATA and its metadata (self-dedup), or re-publish the bytes / attest metadata via `efs.mirrors.add` / `efs.props.set` after placing. (2) Solidity `EFSLib.place` — the standalone hardlink/move primitive the README advertises — now applies the same `ForeignDataUID` self-authorship gate as `placeExisting`, so a foreign placement reverts instead of producing a visible-but-unreadable file.
