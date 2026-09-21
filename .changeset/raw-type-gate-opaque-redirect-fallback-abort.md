---
"@efs/sdk": patch
---

Three review fixes: the raw namespace's type gate is now real — `EfsRawReadNs` uses new read-only contract instantiations (`EfsRawReadContracts`, no `.write.*` at the type level), so a no-wallet client can no longer type-check `raw.eas.write.revoke(...)` that was a runtime `TypeError` (`EfsRawNs` keeps the wallet-backed surface). Browser `opaqueredirect` responses now FAIL the attempt instead of being followed unchecked — the destination is uninspectable, so none of the per-hop SSRF/private-host/downgrade guards can run, and CORS gates response reading, not whether the redirected request reaches a private-network endpoint (supersedes the earlier followed-URL provenance behavior; failover to a direct mirror proceeds). And the raw-SSTORE2 fallback re-checks the abort signal before its `getCode` — an abort during the pending `chunkCount` no longer starts more RPC work.
