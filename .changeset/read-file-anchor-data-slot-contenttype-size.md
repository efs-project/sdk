---
"@efs/sdk": patch
---

fix(reads): resolve file leaves from the DATA anchor slot; trust attested contentType + size

- **File-leaf resolution (P1 — read-side of the file-anchor fix).** `locate`/`read`/`info`/
  `exists` walked the WHOLE path generically (`resolvePath`/`forSchema=0`), but the SDK now
  writes file anchors at `(parent, name, DATA_SCHEMA_UID)` — so SDK-written files read as
  ABSENT. New `resolveFilePathToAnchor` walks parent folders generically, then resolves the
  terminal file segment via `resolveAnchor(parent, name, DATA_SCHEMA_UID)` with a generic
  fallback (legacy anchors / router parity, EFSRouter.sol:240-245).
- **Attested `contentType` (P2).** `EfsFile.contentType` now comes from the author's reserved
  `contentType` PROPERTY (lens-scoped), never the untrusted transport `Content-Type` header a
  gateway can change independently of the attestation.
- **Enforce attested `size` (P2).** The fetch is capped at the author's declared `size`
  PROPERTY, so a mirror body exceeding it is rejected during the fetch instead of returning as
  `matches-author` / forcing over-buffering.
