---
"@efs/sdk": patch
"@efs/solidity": patch
---

fix: file anchors must be DATA-typed (`forSchema = DATA_SCHEMA_UID`), not generic

A FILE's terminal path anchor was encoded with generic `forSchema = bytes32(0)`. The
EFSIndexer keys anchors by `(parent, name, forSchema)`: the router resolves a file's
terminal segment via `resolveAnchor(parent, name, DATA_SCHEMA_UID)` and directory
listing enumerates only `_childrenBySchema[parent][DATA_SCHEMA_UID]`, so a file written
generic landed in the FOLDER bucket — invisible to file listings and colliding with a
same-named folder (a naive single-file `locate` masked it via the router's generic
fallback). Now `graph.ts`'s file anchor and `EFSLib.writeFile`/`placeExisting` encode
`schemas.data`. FOLDER anchors correctly stay generic. The Solidity `FileWrite.forSchema`
field and `placeExisting(..., forSchema)` param are removed (a file is always DATA-typed;
the field was a footgun). Verified against the deployed contracts + the canonical seed.
