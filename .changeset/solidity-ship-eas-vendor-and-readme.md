---
"@efs/solidity": patch
---

fix(solidity): ship the vendored EAS interfaces + remappings.txt in the npm tarball, and fix the README quickstart

The `files` whitelist shipped only `src/**/*.sol`, so a consumer of the published
package hit an import-resolution error: `EFSLib.sol` imports
`@ethereum-attestation-service/eas-contracts/...`, whose vendored source under
`vendor/` was excluded from the tarball. Now ship `vendor/**/*.sol` + `remappings.txt`
so the package compiles standalone (consumers with their own eas-contracts can
override the remapping — the vendored sources are byte-identical to 1.7.1).

The README quickstart called a removed `_efsPinFile(path, dataUID)` and omitted the
`IEAS` constructor arg; rewritten to the current `EFSWriter` API (`_efsPlace`, the
`(IEAS eas)` constructor) with the correct Foundry/Hardhat remappings.
