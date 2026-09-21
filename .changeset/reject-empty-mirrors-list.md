---
"@efs/sdk": patch
---

`fs.write` now rejects an explicitly empty `mirrors` list (`mirrors: []`) with a typed
`InvalidArgument` error instead of falling through to on-chain auto-storage. Supplying
`mirrors` means the bytes already live off-chain and the SDK will not store them, so an
empty list is a caller error (e.g. an optional mirror list that resolved to empty) — the
old fall-through could silently spend gas and publish bytes on-chain. Pass at least one
URI, or omit `mirrors` to opt into on-chain storage.
