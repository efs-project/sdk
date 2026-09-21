---
"@efs/sdk": patch
---

`efs.account.capabilities()` now keys the account probe by the LIVE provider chain
instead of the construction-time `publicClient.chain.id`. The `getCode` classification
and EIP-5792 `getCapabilities` already land on the provider's current chain, so a mutable
EIP-1193 provider that switched networks after the client was built could mix new-chain
bytecode/capabilities into an old-chain cache slot and return the wrong `kind`/gasless
status. Querying `publicClient.getChainId()` for the cache key keeps detection consistent
with the chain the reads actually hit — the last live-chain gap, matching the read and
write paths.
