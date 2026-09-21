---
"@efs/sdk": patch
"@efs/solidity": patch
---

Two hardlink fixes: (1) Solidity `EFSLib.placeExisting` now reverts `ForeignDataUID` unless the DATA was authored by the calling contract — lens-scoped reads key mirrors and content-hash/type properties on the placement attester, so a hardlink to foreign-authored DATA resolved to a UID with no retrieval metadata visible under the placer's lens (an advertised file that cannot be read); re-publish foreign content with `writeFile` instead. (2) The TypeScript graph builder's hardlink short-circuit now honors `overviewSystemTagDef`: the `system` TAG is emitted in a layer strictly before the placement PIN (same no-untagged-flash ordering as normal writes) instead of being silently dropped, which left a hardlinked Overview visible in safety-filtered directory listings.
