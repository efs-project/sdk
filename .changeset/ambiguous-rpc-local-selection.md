---
"@efs/sdk": patch
---

Two correctness fixes: (1) ambiguous JSON-RPC send errors are no longer treated as proof that nothing was broadcast. `RpcError` is removed from the definite-refusal set — `-32000: already known`, `nonce too low`, and `replacement transaction underpriced` all mean the transaction (or a rival for its nonce) is already in the mempool and may mine, so they now surface as the UNKNOWN-send states (`WriteSendUnknownError` / `EasSendUnknown` / `OnchainSendUnknown` / `IndexSendUnknown`) instead of "not sent". Only wallet/provider refusal codes, decoded reverts, and the SDK's own pre-send guards remain definite. (2) List pagination derives its attester selection per request instead of mutating shared primed state — an attester-bound cursor on one `byPage()` call no longer moves a later unbound `byPage()`, `toArray()`, or iteration off the first-ranked candidate on the same `EfsList` handle.
