---
"@efs/solidity": patch
---

fix(solidity): property key-anchors must use `PROPERTY_SCHEMA_UID` as `forSchema`, not generic `bytes32(0)`

`forSchema` is the third key of the EFSIndexer anchor directory
(`_nameToAnchor[parent][name][forSchema]`), so it is load-bearing for resolution,
not cosmetic. `EFSLib.writeFile`'s reserved-key loop and `EFSLib.setProperty` were
filing property key-anchors under a generic `forSchema`, landing them in a
different slot than every spec-conformant reader looks up — including
`EFSRouter._getContentType`, which resolves via
`resolveAnchor(DATA, key, PROPERTY_SCHEMA_UID)`. Result: properties (incl. a
file's `contentType`/`contentHash`/`size`) written through the Solidity SDK were
invisible to the router and to the TS SDK's `props.get`/`props.list`. Now both
write sites pass `schemas.property`, matching the spec, the seeded fixtures, the
EFSRouter, and the TS SDK. Folder/file path-node anchors correctly keep generic
`forSchema`.
