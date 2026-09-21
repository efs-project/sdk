---
"@efs/sdk": patch
---

Two cross-chain safety fixes for clients built on a mutable EIP-1193 provider:

- **Reads now resolve the deployment from the LIVE provider chain** (`eth_chainId`), not
  the construction-time `publicClient.chain.id`. If an injected wallet switches networks
  after the client is built, `readContract` goes to the provider's current chain — so
  resolving from the bound chain would query the old deployment's addresses on the new
  chain (false misses / wrong-chain data). `fs.read`/`info`/`list`/`locate`/`exists`/
  `overview`, the `props`/`redirects`/`lists` read paths, and `raw.verifyDeployment` now
  re-resolve from the live chain (so a switch is reflected, or surfaces `DeploymentNotFound`).
- **`efs.raw.*.write.*` is now guarded against a wrong-chain wallet.** The raw escape-hatch
  contract instances called `walletClient.writeContract` directly, bypassing the
  `WrongChain` preflight the higher-level write verbs run. The wallet handed to the raw
  instances is now wrapped so every write asserts the live wallet chain matches the
  deployment first.
