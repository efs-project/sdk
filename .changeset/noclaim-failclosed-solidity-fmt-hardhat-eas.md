---
"@efs/sdk": patch
"@efs/solidity": patch
---

fix: fail closed on missing contentHash in value helpers; declare EAS dep for Hardhat; Solidity fmt

- **`@efs/sdk` — `no-claim` is now fail-closed in the bare-value helpers.** `readText`/
  `readBytes`/`readJson` with default verification on a file that has NO `contentHash` claim
  previously returned the unverifiable bytes (verification `no-claim` was treated as success).
  They now throw the new `MissingContentHash` when verification was requested — a bare value
  has no status field to warn the caller. `{ verify: false }` opts out (then `no-claim` is
  fine), and `read()` still reports `verification:'no-claim'` without throwing.
- **`@efs/solidity` — declare `@ethereum-attestation-service/eas-contracts@1.7.1` as a
  dependency** so Hardhat consumers resolve the EAS imports from `node_modules` (Hardhat reads
  the consuming project's `node_modules`, not this package's Foundry `remappings.txt`). Foundry
  still uses the shipped vendored copy via remapping. README corrected accordingly.
- **`@efs/solidity` — fix `forge fmt` formatting** of `_efsPlaceExisting` (the failing
  Solidity CI check).
