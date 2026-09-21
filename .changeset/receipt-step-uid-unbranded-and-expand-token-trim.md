---
"@efs/sdk": patch
---

Two public type-surface fixes:

- **`WriteReceipt.steps[].uid` is now `Hex`, not `DataUID`.** Steps record every minted
  attestation (file-ANCHOR, MIRROR, PROPERTY, placement-PIN, TAG, LIST_ENTRY, REDIRECT,
  DATA, …), so branding them all as `DataUID` let placement/property/anchor UIDs be passed
  where a file-content identity is required — defeating the wrong-UID-kind guard the brand
  exists for. The file's content identity remains `receipt.data.uid` (`DataUID`); a step's
  kind is conveyed by its `id`.
- **`ExpandToken` no longer includes `'mirrors'`/`'redirects'`.** Those tokens were in the
  public union but never hydrated (no result field, no read-path handling), so
  `info(path, { expand: ['mirrors'] })` silently no-opped. They are removed until
  implemented (added back additively when a verb hydrates them); read mirrors via
  `efs.mirrors.list(...)` and redirects via `followRedirects`/`ReadResult.via` meanwhile.
