---
"@efs/sdk": patch
"@efs/solidity": patch
---

fix: web3 transport resolves the `/transports/onchain` anchor; Solidity writeFile overwrite

- **`@efs/sdk` (P1)** — the on-chain transport fallback for a default `web3://` write now resolves the
  `/transports/onchain` anchor (the scheme key is `web3`, but the bootstrap anchor is named `onchain`
  — per the deploy fixture). It previously resolved `/transports/web3`, which doesn't exist, so a
  default no-mirror write on a deployment that seeded the real anchor but not the inline `transports`
  map (the built-in Sepolia entry) still threw `MissingTransport`. Same fix applied to `efs.mirrors.add`.
- **`@efs/solidity` (P2)** — `EFSLib.FileWrite` gains an optional `existingFileAnchorUID`: when set,
  `writeFile` reuses that permanent file-ANCHOR instead of re-minting it (which reverts on the duplicate
  slot), so a contract can OVERWRITE a path in place (the new placement PIN supersedes the prior one).
  `bytes32(0)` keeps the mint-fresh behavior for a new file.
