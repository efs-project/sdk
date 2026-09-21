# Vendored EAS interfaces (eas-contracts 1.7.1)

These are the **interface-only** Solidity files from
`@ethereum-attestation-service/eas-contracts@1.7.1` (MIT, see `LICENSE`),
vendored (committed here under `vendor/`, unlike clone-on-setup deps in `lib/`)
so `@efs/solidity` compiles standalone with no npm/registry install or network.

Only the files EFSLib needs are included:

- `contracts/IEAS.sol` — `IEAS`, `AttestationRequest`, `AttestationRequestData`
- `contracts/Common.sol` — `Attestation`, `EMPTY_UID`
- `contracts/ISchemaRegistry.sol`, `contracts/ISemver.sol`,
  `contracts/resolver/ISchemaResolver.sol` — transitive imports of `IEAS.sol`

The import paths (`@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol`)
are **byte-identical** to the frozen EFS contracts (`SystemAccount.sol` et al.),
so EFSLib's EAS usage matches production exactly. A consumer that already pins
eas-contracts can override the `@ethereum-attestation-service/eas-contracts/`
remapping to point at their copy.
