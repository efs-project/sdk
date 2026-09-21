---
"@efs/sdk": patch
"@efs/solidity": patch
---

The readability invariant closes out across write entry points: (1) `buildFileWriteGraph` rejects a byte plan with an empty mirror set — the exported builder could mint a fully-confirmed file whose every `read()` fails `AllMirrorsFailedError` (the orchestrated `fs.write` paths already auto-store or reject). (2) Solidity `writeFile` reverts the new `EmptyMirrorSet` before anything mints when `w.mirrors` is empty (the docs previously said "may be empty"). (3) `redirects.set` gates DIRECT symlink→DATA links: path resolution reports the symlink author as `resolvedBy` and reads scope retrieval metadata to that address, so a symlink at a DATA whose mirrors live under someone else resolved but could never be read — the author must have their own active mirror on the target (or symlink to the file's ANCHOR, where the walk uses the placement winner's metadata); symlink→ANCHOR and sameAs/supersededBy edges are unaffected.
