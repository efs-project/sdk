---
"@efs/sdk": patch
"@efs/solidity": patch
---

Three fixes: (1) `efs.props.list` pages `getAnchorsBySchema` against the raw `getChildCountBySchema` count — the old full-page-implies-more loop probed one window past an exact page-multiple (256/512/… property keys), which the indexer's slice helper reverts (`InvalidOffset`), failing the whole listing. (2) Transport UIDs are validated/canonicalized BEFORE they can gate paid storage: deployment `transports` maps are canonicalized at `resolveDeployment` alongside schemas, and the write path's transport resolver rejects a template-compatible-but-malformed `transportDefinition` (`'0x01'`, non-hex) up front — previously it sailed through both irreversible SSTORE2 deploys and only exploded at the MIRROR ABI-encode, leaving paid storage with no receipt. (3) Solidity placement funnels (`placeExisting` and `place`) now also require the target to BE a DATA attestation (`NotDataUID(uid, schema)`): a self-authored ANCHOR/PROPERTY UID passed the authorship gate but pinned into the wrong schema slot — an `EFSFileWritten` placement no SDK reader could see.
