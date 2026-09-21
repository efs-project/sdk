---
"@efs/sdk": patch
---

Numeric-option validation swept across the remaining public entry points (same class as the prior wave, exhausted this time): `resolveTransport` rejects non-finite/non-positive `maxBytes` directly (callers bypassing `fetchVerified` were unprotected — a NaN cap decoded arbitrarily large `data:` payloads); `redirects.history` validates `maxHops` (NaN walked zero edges and mis-reported the start as history; fractional caps now floor); `verifyAttestationUID` bounds `maxBump` to the uint32 bump range (Infinity hung the event loop on synchronous keccak work; NaN false-negatived); `fetchVerified` validates `timeoutMs` (NaN fired the abort timer immediately). Also: the `efs.account.capabilities()` probe now routes `getCode` through the chain-guarded client pinned to the sampled live chain — a provider that drifts mid-probe fails closed (`WrongChain`) instead of caching another chain's bytecode/capabilities under the sampled chain's key.
