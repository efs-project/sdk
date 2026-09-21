---
"@efs/sdk": patch
---

Four input-validation/honesty fixes from review: a `NaN`/non-positive `write.onchainAutoLimit` now throws `InvalidArgument` before the size gate (it previously disabled the cap comparison entirely, waving any payload into gas-spending storage deploys); `followRedirects` with a non-finite number throws `InvalidArgument` instead of silently disabling the following the caller explicitly requested; the browser `opaqueredirect` fetch path reports the FOLLOWED response's final URL as `urlUsed` (provenance named the pre-redirect endpoint); and `efs.toJSON` throws `InvalidArgument` for `undefined`/function/symbol roots rather than returning runtime `undefined` against its `string` signature.
