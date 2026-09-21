---
"@efs/sdk": patch
---

Two review fixes: (1) `efs.account.capabilities()` accepts `{ refresh: true }` — the client-level invalidation lever for the capability-profile cache. The probed inputs are mutable on-chain state (a counterfactual smart-account deploy or an EIP-7702 delegation added/removed changes the account's code without changing the cache key), and provider-form callers cannot reach the internally-created wallet object that scopes the cache; the option evicts the live-chain cache entry and re-probes. (2) `parseWriteReceipt` now REBUILDS the nested `data` ref (validated fields + `__brand: 'DataRef'` + profile) instead of spreading the payload through — an external artifact could omit or forge the brand and violate the branded `WriteReceipt.data: DataRef` contract; the construction is shared with `parseDataRef` via one helper.
