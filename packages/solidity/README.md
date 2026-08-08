# @efs/solidity

On-chain (Solidity) SDK for the **Ethereum File System (EFS)** — a **compile-in library** for reading and writing EFS from your own smart contract.

See [`docs/adr/0003`](../../docs/adr/0003-onchain-sdk-as-compile-in-source.md).

## Why a library (not a deployed contract)

EFS keys all content by **attester address** (`msg.sender` at EAS). This library's functions are `internal` and inline into *your* contract, and `EFSWriter` is an inheritable base — both keep **your contract** as the attester. A separately deployed helper you `CALL` would become the attester and collapse every consumer into one identity. So: compile it in, don't deploy it.

## Install

```bash
npm i @efs/solidity
```

The package declares `@ethereum-attestation-service/eas-contracts@1.7.1` as a dependency
(so `npm i @efs/solidity` installs it into your `node_modules`) **and** ships a
byte-identical vendored copy of the EAS interfaces under `vendor/` (so a Foundry project
can compile standalone via a remapping, without relying on `node_modules` layout).

**Hardhat** — works with no extra config: `@efs/solidity/...` resolves from
`node_modules/@efs/solidity`, and `@ethereum-attestation-service/eas-contracts/...`
resolves from `node_modules/@ethereum-attestation-service/eas-contracts` (the declared
dependency). Hardhat's package-import resolution reads your project's `node_modules`, not
this package's Foundry `remappings.txt`, which is why the dependency must be declared.

**Foundry** — add to `remappings.txt`:

```
@efs/solidity/=node_modules/@efs/solidity/
@ethereum-attestation-service/eas-contracts/=node_modules/@efs/solidity/vendor/eas-contracts/
```

The import `@efs/solidity/src/v1/EFSWriter.sol` then resolves to
`node_modules/@efs/solidity/src/v1/EFSWriter.sol` (the remapping points at the package
root; the `src/` is part of the import path). You may instead point the second remapping
at `node_modules/@ethereum-attestation-service/eas-contracts/` (the installed dependency)
— the sources are identical, so either resolves.

## Use

Inherit `EFSWriter` (its constructor takes the `IEAS` instance) and call the
`_efs*` wrappers — every write is attested as **your contract**:

```solidity
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EFSWriter} from "@efs/solidity/src/v1/EFSWriter.sol";
```

> **The `v1` in the path is the PROFILE (ADR-0019/R6):** these libraries wrap the
> EFS **v1** deployment (the 9 frozen EAS schemas). A future native-v2 library
> lands at `src/v2/` in this package (or a sibling package) without changing the
> meaning of any `v1` import — the profile is explicit in every import statement,
> greppable in any consumer, while contract code keeps clean unversioned symbol
> names (`EFSLib`, not `EFSLibV1`).

```solidity
import {EFSLib} from "@efs/solidity/src/v1/EFSLib.sol";

contract MyApp is EFSWriter {
    // The frozen EFS schema UID set for your target chain (from the deployments registry).
    EFSLib.SchemaUIDs internal schemas;

    constructor(IEAS eas, EFSLib.SchemaUIDs memory schemas_) EFSWriter(eas) {
        schemas = schemas_;
    }

    /// Place an existing DATA at a path anchor (the hardlink / "pin" primitive).
    /// The DATA must be YOUR OWN (authored by this contract) — placing foreign DATA
    /// reverts `ForeignDataUID`: lens-scoped reads resolve mirrors/properties under
    /// the placing attester, so a foreign placement would be visible but unreadable.
    function place(bytes32 anchor, bytes32 dataUID) external returns (bytes32 pinUID) {
        pinUID = _efsPlace(schemas, anchor, dataUID); // your contract is the attester
    }
}
```

For reads, use the `EFSReader` library directly (it takes the `EdgeResolver` /
`IEAS` / `EFSIndexer` instances as arguments; no inheritance needed).

## Surface

- **`EFSWriter`** — inheritable base (constructor `(IEAS eas)`) with EFS-level events and the
  `internal` write wrappers: `_efsWriteFile` (full file), `_efsPlaceExisting` / `_efsPlace`
  (hardlink/move — own DATA only, `ForeignDataUID` otherwise), `_efsAnchorAt` (mkdir), `_efsTag`, `_efsSetProperty`, `_efsCreateList` /
  `_efsAddEntry`, `_efsSetRedirect`.
- **`EFSLib`** — the `internal` write primitives the wrappers delegate to (use directly if you
  don't want the base contract).
- **`EFSReader`** — `internal` lens-scoped reads: `resolveAnchor` / `resolvePath`, `activePin`,
  `propertyValue`, `listChildren` / `listEntries`, `redirectTarget` / `resolveWithRedirects`.

## Develop

```bash
forge build      # compile the library
forge test       # unit tests (incl. asserting msg.sender survives inlining)
forge fmt
```

Tests live in `test/` and are **not** published — the npm package ships `src/**/*.sol`, the
vendored EAS interfaces under `vendor/`, and `remappings.txt`.
