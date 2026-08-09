---
"@efs/sdk": patch
---

`fs.write` and `efs.mirrors.add` now reject a mirror URI over MirrorResolver's 8192-byte
limit (`MAX_URI_LENGTH`) before submitting, alongside the existing empty-URI guard. An
oversized URI reverts at the MIRROR layer — and in `fs.write` that revert lands after the
L1 DATA attestation has already mined, orphaning a partial write — so both paths now
preflight the UTF-8 byte length (MirrorResolver checks `bytes(uri).length`, not the JS
string length) and throw a typed `InvalidArgument`. The empty/oversized checks are unified
in a shared `validateMirrorUri` helper.
