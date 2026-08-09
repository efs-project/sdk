---
"@efs/sdk": patch
---

Two read-path fixes:

- **(P1) An author-declared `size` can no longer raise the fetch cap.** On the default
  `read()`/`readText()` (no `opts.maxBytes`), `opts.maxBytes ?? declaredSize` made a large
  declared `size` the engine cap, so an untrusted attester claiming e.g. 1 GB bypassed the
  documented 50 MB default and could force buffering before verification/failure. The
  declared size now only LOWERS the cap (caller `maxBytes` if set, else the engine default;
  clamped down by `declaredSize`), never raises it.
- **(P2) `read` byte-fetch options now forward an abort `signal`.** `FetchOptions` gains
  `signal?: AbortSignal`, threaded into the mirror engine, so a caller (e.g. an aborted
  server request) can cancel a slow mirror read promptly instead of waiting out the
  per-attempt timeout.
