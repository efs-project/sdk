---
"@efs/sdk": patch
---

The default `fs.write(path, bytes)` on-chain (SSTORE2) storage path now routes its
wallet/RPC calls through the same `classifyError` funnel the submitter uses. A wallet
rejection or RPC failure during the chunk deploy, manager deploy, or receipt wait now
surfaces as the documented EFS error tree (`UserRejected` / `RpcError` / typed write
errors) instead of a raw viem/provider error — so callers handling the EFS error tree no
longer miss the common quickstart write path. Abort (`signal`) still propagates as the
caller's `AbortError` (the pre-send checks stay outside the funnel), and typed errors like
`MultiChunkUnsupported` pass through unchanged (the classifier is idempotent).
