---
"@efs/sdk": patch
"@efs/solidity": patch
---

fix: paginate props.list; gate edge writes with WalletRequired; abort between on-chain deploys; doc bare contentHash

- **`@efs/sdk` — `props.list` pagination.** It hard-coded one page (start 0, size 256) and
  ignored the cursor, so a DATA with >256 property key-anchors silently returned only the
  first page. It now loops until the cursor is exhausted, returning every property.
- **`@efs/sdk` — edge-write wallet gate.** On a read-only client the graph/props/mirrors/
  redirects/lists write methods exist at runtime (the type hides them) and reached
  `edgeSubmitContext`, where the absent wallet threw a raw `TypeError`. It now throws
  `WalletRequired` first, matching `fs.write`/`eas`.
- **`@efs/sdk` — abort between on-chain deploys.** `storeOnchain` now takes the abort signal
  and checks it before each of its two irreversible deploys (chunk, then chunk-manager), so
  an abort after the chunk lands no longer still sends the manager tx.
- **`@efs/solidity` — bare `contentHash` doc.** `FileWrite.reservedKeys` NatSpec instructed a
  `0x…`-prefixed `contentHash`; the read/verify path treats that as `malformed-claim`. It now
  documents the bare lowercase 64-hex ADR-0006 digest (no `0x`).
