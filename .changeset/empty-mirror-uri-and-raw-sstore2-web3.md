---
"@efs/sdk": patch
---

Two fixes:

- **`fs.write` rejects an empty/blank mirror URI per element.** Previously only an empty
  `mirrors: []` array was rejected; `mirrors: ['']` with an explicit `transportDefinition`
  bypassed the scheme check and mapped the empty URI into the MIRROR plan, so the L2 MIRROR
  batch reverted (MirrorResolver requires a non-empty URI) *after* the L1 DATA attestation
  had landed — orphaning a partial write. Each supplied URI is now validated non-empty
  before any tx (`InvalidArgument`).
- **`web3://` reads support raw single-SSTORE2 targets.** A `web3://` mirror that points
  directly at a raw SSTORE2 data contract (an older on-chain store, or one written by
  another client) has no `chunkCount()`. The SDK treated that probe failure as fatal,
  failing reads when such a mirror was the only one. It now mirrors the canonical router:
  on a failed `chunkCount()` it reads the target's own bytecode and strips the leading
  SSTORE2 STOP byte (`EFSRouter.sol` web3:// fallback — router parity, ADR-0013).
