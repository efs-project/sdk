---
"@efs/sdk": patch
"@efs/solidity": patch
---

fix: normalize `ar://` write mirrors, honor `WriteOptions.signal`, correct the Foundry remapping

- **`@efs/sdk`** — `fs.write` now normalizes an `ar://` mirror's scheme to the canonical
  `arweave` transport key (matching the read resolver and `mirrors.add`), so Arweave writes
  no longer throw `MissingTransport` unless a `transportDefinition` is supplied manually.
- **`@efs/sdk`** — `WriteOptions.signal` is now honored: the write checks the `AbortSignal`
  before the first irreversible step (on-chain storage) and before each layer's `multiAttest`,
  so an already-aborted (or mid-write aborted) signal stops further irreversible transactions.
  It is never checked mid-flight — a broadcast tx can't be unsent — so aborting between layers
  leaves a partial write, the same boundary as a revert.
- **`@efs/solidity`** — fix the README Foundry remapping (`@efs/solidity/=node_modules/@efs/solidity/`,
  not `.../src/`) so the documented `@efs/solidity/src/EFSWriter.sol` import resolves.
