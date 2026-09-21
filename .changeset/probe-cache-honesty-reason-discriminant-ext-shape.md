---
"@efs/sdk": patch
---

Three review fixes: a TRANSIENT `getCapabilities` failure no longer freezes a fulfilled no-capabilities profile into the connector cache — only a rejection the classifier identifies as `UnsupportedMethod` (EIP-1193 4200 / method-not-found) is a durable, cacheable answer; anything else falls back for that call and re-probes on the next, so `efs.account.capabilities()` can't permanently report `gasless: false` off one RPC hiccup. `parseWriteReceipt` enforces the CLOSED `reason.why` union (branding an unknown literal broke exhaustive switches) and rejects a `reason.selected` inconsistent with `mechanism` (it documents itself as mirroring it). And the envelope's `ext`, when present, must be a plain record — `null`/arrays/scalars die as `MalformedArtifact` instead of flowing through a signature promising `Record<string, unknown>`.
