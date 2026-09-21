---
"@efs/sdk": patch
---

Close the last two cross-chain gaps for mutable EIP-1193 clients:

- **Writes now guard the public client too, not just the wallet.** `fs.write`,
  `fs.setOverview`, and the standalone edge writes use the public client for parent/transport
  reads and `waitForTransactionReceipt`. If a `ViemConfig` public client drifted to another
  chain while the wallet stayed on the deployment chain, the write could send on the
  deployment chain yet read/wait on the wrong one. The write preflight now asserts BOTH the
  wallet and the public client are on the deployment chain (skipped only when there's no
  bound account, where the write fails closed with `WalletRequired` anyway).
- **`efs.eas.getAttestation` and `efs.decode(uid)` guard a drifted public chain.** They read
  at the construction-chain EAS address; the public client handed to `makeEasVerbs` now
  validates the live chain matches the deployment, failing closed with `WrongChain` on drift
  rather than returning a false absence or wrong attestation from the old address.
