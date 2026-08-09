---
"@efs/sdk": patch
---

`fs.overview()`'s `source` field now derives from the mirror the fetch ACTUALLY used, not from mirror presence — an Overview with both `web3://` and off-chain mirrors previously reported `source: 'onchain'` even when an HTTPS/data: mirror served the bytes (or `transports` excluded web3), inviting consumers to offer `setOverview` editing for read-only mirror-hosted bytes. Supporting this, `EfsFile` gains an optional `mirrorUsed` provenance field (the winning mirror URI, populated by the fetch path).
