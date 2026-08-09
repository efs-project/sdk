---
"@efs/sdk": patch
"@efs/solidity": patch
---

Two symmetry completions: (1) the EFSIndexer legs get the last missing send split — a code-less transport loss during `index`/`indexRevocation` now throws the new `IndexSendUnknown` (no hash exists; may still mine; `efs.index(uid)` is the safe idempotent reconcile), the redirect wrappers thread it onto `IndexingIncomplete.indexBroadcastUnknown` with an honest message instead of claiming the leg never broadcast, and the partial receipt counts the signed prompt (the wallet signed before the transport dropped). Refusal responses stay classified. (2) Solidity `setPropertyAt` validates the reused key-anchor before binding: it must be an ANCHOR in the PROPERTY bucket (`NotPropertyKeyAnchor` otherwise) — a PROPERTY bound at a file/folder anchor confirmed UIDs the canonical `resolveAnchor(dataUID, key, PROPERTY)` lookup never reaches, matching the TS reuse path's checks.
