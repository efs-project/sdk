---
"@efs/sdk": patch
---

`opts.contentType` is now validated as an IANA media type before anything irreversible happens. specs/future-proofing.md §8 makes the attested `contentType` authoritative — readers never fall back to the transport header or the file extension — and requires validation on write, but a malformed value like `'not-a-media-type'` rode unchecked into the paid `EFSBytesStore` deploy (an ERC-5219 store that then reports nonsense to every gateway) and into the authoritative `contentType` PROPERTY, where it made `fs.overview()` classify plainly textual content as binary. The check runs at the top of `resolveMirrors`, before the deploys, for the same reason the transport-anchor gate does: past that line the gas is spent and a late throw strands orphaned storage. `type/subtype` with optional parameters (`; charset=utf-8`) is accepted; omitting `contentType` still leaves the file undeclared.
