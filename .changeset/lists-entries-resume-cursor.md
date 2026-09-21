---
"@efs/sdk": patch
---

fix(reads): `efs.lists.entries` honors a constructor-level `cursor` for the initial page

A caller resuming with `efs.lists.entries(listUID, { cursor })` and then iterating / calling
`byPage()` without a per-page cursor was restarting at offset 0 (only `pageOpts.cursor` was read),
duplicating entries for anyone who persisted a `Page.cursor`. The first page now falls back to
`opts.cursor`; subsequent pages thread their own advanced cursor.
