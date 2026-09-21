---
"@efs/sdk": patch
---

`contentType` validation moved onto the shared plan builder and gained a size ceiling.

The earlier fix validated only `fs.write`'s `opts.contentType`, but `efs.props.set(dataUID, 'contentType', …)` writes the same authoritative binding through a different door and stayed unchecked — a caller could replace a file's `contentType` with `'not-a-media-type'`, after which readers expose the malformed value and `fs.overview()` misclassifies textual content as binary. `assertContentType` now lives beside `buildPropertyPlan` and runs inside it whenever the canonical key is `contentType`, so `props.set` and direct callers of the exported builder are both covered. Other property keys are unaffected — this is a reserved-key rule, not a value policy for every property.

A `MAX_CONTENT_TYPE_BYTES` ceiling (255 bytes) also now applies. A syntactically valid but enormous media type is ABI-encoded into the `EFSBytesStore` creation transaction, and on the default no-mirror path the SSTORE2 content chunk is deployed FIRST — so an initcode-breaking value left the caller with storage they had already paid for and a write that could not complete. RFC 6838 caps type and subtype names at 127 characters each, so 255 admits any registered `type/subtype` with room for parameters.
