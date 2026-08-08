---
"@efs/sdk": patch
---

Three review fixes: (1) `buildRawContracts` is now overloaded on the wallet — building without a wallet client returns `EfsRawReadContracts` (no `.write.*` surface at the type level), so a no-wallet consumer can no longer type-check `raw.eas.write.revoke(...)` that was a runtime `TypeError`; the wallet may now also be omitted entirely instead of passing `wallet: undefined`. (2) `efs.props.set` routes its key-anchor planning read through the chain-guarded read client like every other planner, closing a provider-drift window that could feed a wrong-chain key-anchor UID into the plan (partial write: PROPERTY mines, binding PIN reverts). (3) The content-hash spec and `FetchOptions.maxBytes` docs now describe the real declared-size contract: the author's `size` claim is a POST-fetch consistency check (`mismatch`), never a transport cap — a small claim does not shrink the allocation bound; set `maxBytes` for that.
