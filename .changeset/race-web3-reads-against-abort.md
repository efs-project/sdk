---
"@efs/sdk": patch
---

The fetch engine's `web3://` attempt now RACES the reader promise against the per-attempt abort signal: the in-reader signal checks run between chunk RPCs, so a single `readContract`/`getCode` on a transport with no timeout of its own could still hold the await open past `timeoutMs` and block mirror failover indefinitely. The attempt now settles when the timer fires (the orphaned RPC keeps running without an abortable transport — documented — but failover proceeds and its eventual rejection is swallowed).
