---
"@efs/sdk": patch
---

Fix `efs.fs.list(path, { excludes })` returning empty pages / dropping normal files. The
filtered directory read (`getDirectoryPageFiltered`) was passed `schemas.anchor` as the
child-anchor schema bucket, but that argument is the `forSchema` BUCKET KEY the walk
scans (`_childrenBySchema[parent][schema]`) and the folder-visibility tag `definition` —
not the schema of the anchor attestation. SDK-written file anchors are bucketed under
`schemas.data` (DATA_SCHEMA_UID) and folder-visibility tags use `definition =
DATA_SCHEMA_UID`, so the ANCHOR-schema bucket was empty and enabling safety excludes
skipped ordinary files. Now passes `schemas.data`, matching the production client.
