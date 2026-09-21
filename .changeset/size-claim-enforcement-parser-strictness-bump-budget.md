---
"@efs/sdk": patch
---

Three review fixes: the declared `size` claim is now enforced on the FETCHED bytes even when it is `0` (the empty-file carve-out can't clamp the fetch cap, so a non-empty body whose hash matched inconsistent metadata previously verified `matches-author`; it is now the documented `mismatch`); `verifyAttestationUID`'s `maxBump` bound is the practical scan budget (`MAX_UID_BUMP_SCAN = 1024`, new export) rather than the uint32 wire range — the wire maximum meant 4.3 billion synchronous keccaks freezing the event loop; and the artifact parsers are strict at the promised boundary — `parseDataRef` shape-validates `uid` (bytes32), `resolvedBy` (address), and `chainId` (positive safe integer), and `parseWriteReceipt` rejects NaN/fractional `signatureCount` and non-bytes32 step uids as `MalformedArtifact` instead of branding corrupt IDs that fail later as misleading chain/ABI errors.
