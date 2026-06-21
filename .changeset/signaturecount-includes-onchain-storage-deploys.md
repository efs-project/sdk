---
"@efs/sdk": patch
---

`WriteReceipt.signatureCount` now reports the HONEST wallet-confirmation count on the
default `fs.write(path, bytes)` path. Previously it counted only the EAS attestation
layers and omitted the two on-chain storage deploys (the SSTORE2 chunk + the
`EFSBytesStore` manager) that `resolveMirrors` sends first — so UIs and accounting/retry
flows under-reported the default write by two signatures. `storeOnchain` now returns its
transaction hashes, `resolveMirrors` surfaces a `storageTxCount`, and the orchestrator
folds it into `signatureCount` (`EAS layers + storage deploys`). Caller-supplied mirrors
add zero (the SDK stores nothing).
