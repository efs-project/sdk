# @efs/solidity

On-chain (Solidity) SDK for the **Ethereum File System (EFS)** — a **compile-in library** for reading and writing EFS from your own smart contract.

See [`docs/adr/0003`](../../docs/adr/0003-onchain-sdk-as-compile-in-source.md).

## Why a library (not a deployed contract)

EFS keys all content by **attester address** (`msg.sender` at EAS). This library's functions are `internal` and inline into *your* contract, and `EFSWriter` is an inheritable base — both keep **your contract** as the attester. A separately deployed helper you `CALL` would become the attester and collapse every consumer into one identity. So: compile it in, don't deploy it.

## Install

```bash
npm i @efs/solidity
```

The package ships its EFS sources **and** a byte-identical vendored copy of the EAS
interfaces (`@ethereum-attestation-service/eas-contracts@1.7.1`, under `vendor/`) so it
compiles standalone. Add these remappings to your project:

**Foundry** — `remappings.txt`:

```
@efs/solidity/=node_modules/@efs/solidity/src/
@ethereum-attestation-service/eas-contracts/=node_modules/@efs/solidity/vendor/eas-contracts/
```

> If your project already depends on `eas-contracts`, point the second remapping at
> your own copy instead — the vendored sources are identical, so either resolves.

**Hardhat** resolves `@efs/solidity/...` and `@ethereum-attestation-service/...` from
`node_modules` directly (the vendored EAS sources travel with the package).

## Use

Inherit `EFSWriter` (its constructor takes the `IEAS` instance) and call the
`_efs*` wrappers — every write is attested as **your contract**:

```solidity
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EFSWriter} from "@efs/solidity/src/EFSWriter.sol";
import {EFSLib} from "@efs/solidity/src/EFSLib.sol";

contract MyApp is EFSWriter {
    // The frozen EFS schema UID set for your target chain (from the deployments registry).
    EFSLib.SchemaUIDs internal schemas;

    constructor(IEAS eas, EFSLib.SchemaUIDs memory schemas_) EFSWriter(eas) {
        schemas = schemas_;
    }

    /// Place an existing DATA at a path anchor (the hardlink / "pin" primitive).
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
  (hardlink/move), `_efsAnchorAt` (mkdir), `_efsTag`, `_efsSetProperty`, `_efsCreateList` /
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
