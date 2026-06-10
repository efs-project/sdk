# @efs/solidity

On-chain (Solidity) SDK for the **Ethereum File System (EFS)** — a **compile-in library** for reading and writing EFS from your own smart contract.

> **Status: scaffold.** Signatures are shaped per the design; bodies are stubs until the build lands. See [`docs/adr/0003`](../../docs/adr/0003-onchain-sdk-as-compile-in-source.md).

## Why a library (not a deployed contract)

EFS keys all content by **attester address** (`msg.sender` at EAS). This library's functions are `internal` and inline into *your* contract, and `EFSWriter` is an inheritable base — both keep **your contract** as the attester. A separately deployed helper you `CALL` would become the attester and collapse every consumer into one identity. So: compile it in, don't deploy it.

## Install & import

```bash
npm i @efs/solidity
```

**Hardhat** (resolved via `node_modules`):

```solidity
import "@efs/solidity/src/EFSWriter.sol";

contract MyApp is EFSWriter {
    function save(string calldata path, bytes32 dataUID) external {
        _efsPinFile(path, dataUID); // your contract is the attester
    }
}
```

**Foundry** — add to `remappings.txt`:

```
@efs/solidity/=node_modules/@efs/solidity/
```

## Surface

- `EFSLib` — `internal` helpers: `read` / `readAs` (lens-scoped), `pinFile`, `mkdir`.
- `EFSWriter` — inheritable base with EFS-level events + the happy-path wrappers.

## Develop

```bash
forge build      # compile the library
forge test       # unit tests (incl. asserting msg.sender survives inlining)
forge fmt
```

Tests live in `test/` and are **not** published — the npm package ships `src/**/*.sol` only.
