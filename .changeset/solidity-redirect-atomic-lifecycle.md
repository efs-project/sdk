---
"@efs/solidity": patch
---

`EFSLib.setRedirect` now completes the REDIRECT indexing lifecycle ATOMICALLY: it takes the EFSIndexer (thin new `IEFSIndexerWrite` interface) and calls `index(redirectUID)` in the same transaction — `AliasResolver` never populates the referencing index that every SDK discovery read queries, so the old attest-only form produced redirects invisible to `redirects.get/list`, canonicalization, history, and symlink following until someone manually repaired them. The new `removeRedirect` helper does the second leg the same way (revoke + same-tx `indexRevocation` — a bare `eas.revoke()` leaves the redirect being served by filtered reads), and `EFSWriter` gains `_efsRemoveRedirect` while `_efsSetRedirect` takes the indexer. Because both legs run in one transaction, the partial "attested but undiscoverable" state the two-transaction TypeScript path must model cannot exist for contract writers.
