---
"@efs/sdk": patch
---

Three review fixes: an explicitly empty `transports: []` allowlist is honored as "no transports allowed" (zero candidates → the read fails) instead of silently widening to every scheme — omitting the option remains the allow-all form; the chain-guarded read proxy re-checks the LIVE chain AFTER each `readContract`/`getCode` resolves, so a provider that switches between the pre-check and the actual call can no longer have its chain-B result accepted as chain-A data (the capability probe could cache wrong-chain bytecode; ordinary reads could return wrong-chain values); and caller CANCELLATION propagates as the abort itself — `fetchVerified` no longer converts an aborted signal into `AllMirrorsFailedError`, and the read path passes `AbortError` through the classify funnel raw, so UIs can distinguish "user cancelled" from "mirrors are down".
