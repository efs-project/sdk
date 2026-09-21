---
"@efs/sdk": patch
---

`?format=raw` (IPIP-402) now rides only on bare RAW-block IPFS CIDs, not on every `ipfs://` locator. For a raw-codec (`0x55`) CID the block IS the file's bytes, but for dag-pb/UnixFS — every CIDv0 `Qm…` and the `bafybei…` CIDv1s — the raw block is a protobuf node wrapping the payload (links only, for a multi-block file). Forcing raw asked compliant gateways for that wrapper, so the fetch engine re-hashed the block instead of the content: a perfectly valid IPFS mirror read back as `verification: 'mismatch'` and `readBytes`/`readText` threw. Subpaths (`ipfs://<cid>/dir/a.txt`) are UnixFS directory walks and never qualify either. The check is conservative — anything not provably a raw block skips the parameter and takes the gateway's normal file response, since the cost of guessing wrong is a file that never reads while the cost of omitting the hint is nil. Gateways remain untrusted regardless: every byte is still re-hashed against the attested `contentHash`.
