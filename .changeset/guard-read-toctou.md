---
"@efs/sdk": patch
---

Close a read-path TOCTOU: `readContext` resolved the deployment from the live chain but then
handed the read engines an UNGUARDED `publicClient`. A mutable EIP-1193 provider that switched
chains between `liveDeployment()` resolving and the engines' `readContract`/`getCode` calls
(`fs.read`/`locate`/`info`/`list`) would use the resolved chain's addresses on the new chain —
false misses / wrong-chain data. `readContext` now wraps the read client with a guard pinned to
the RESOLVED `deployment.chainId`, re-asserting `live === resolved` before each read and failing
closed with `WrongChain` on drift. The `chainGuardedPublicClient` proxy now also guards `getCode`
(the web3:// SSTORE2 read transport); `getEnsAddress` stays unguarded (ENS is cross-chain).
