---
"@efs/sdk": patch
"@efs/solidity": patch
---

fix: fs.list honors initial cursor + rejects zero limits; Solidity listChildren enumerates children

- **`@efs/sdk` — `fs.list` initial cursor.** A caller resuming with `efs.fs.list(path, { cursor })`
  now starts the first page/iteration at that cursor instead of restarting at offset 0 (byPage and
  the iterator fall back to `opts.cursor` when no per-page cursor is supplied).
- **`@efs/sdk` — reject zero per-page directory limit.** `fs.list(path).byPage({ limit: 0 })` now
  throws `InvalidDirectoryQuery` instead of passing `maxItems: 0` to the view (a contract revert / a
  non-progressing empty page).
- **`@efs/solidity` — `EFSReader.listChildren` enumerates a folder's children.** It forwarded to
  `getFilesAtPath` (active DATA placements AT the anchor), so a normal directory with children but
  no DATA pinned returned empty. It now calls `getDirectoryPageBySchemaAndAddressList`.
