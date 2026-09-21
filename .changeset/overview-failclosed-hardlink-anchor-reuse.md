---
"@efs/sdk": patch
---

fix(reads/writes): Overview fails closed on bad verification; hardlink plans reuse existing anchors

- **Overview verification.** `efs.fs.overview` rendered `file.text()`/`file.bytes` without checking
  `file.verification`, so a tampered or unverifiable README could display as a folder header with no
  warning (the result has no status field). It now fails closed — throws `ContentHashMismatch`/
  `MalformedClaim`/`MissingContentHash` unless `verify:false` — matching the bare-value read helpers.
- **Hardlink anchor reuse.** The hardlink/relink graph branch returned before the
  `existingFileAnchorUID` handling, so relinking to an existing path still minted a fresh (permanent)
  file ANCHOR and reverted on the duplicate slot. It now honors `existingFileAnchorUID` too — reuses
  the existing anchor and lets the placement PIN supersede.
