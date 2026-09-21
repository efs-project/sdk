---
"@efs/sdk": patch
---

Two follow-up fixes:

- **`efs.mirrors.add` rejects an empty/blank URI** with a preflight `InvalidArgument`,
  matching the guard `fs.write` already has. Previously an explicit `transport` UID made
  `resolveMirrorTransport` return before any URI check, so `mirrors.add(data, { uri: '',
  transport })` encoded an empty URI into the MIRROR plan and the caller signed a tx that
  MirrorResolver could only revert.
- **The `web3://` raw-SSTORE2 fallback is now scoped to genuine on-chain "not a chunk
  manager" misses.** It previously caught *any* `chunkCount()` failure, so a transport/RPC
  error (timeout, rate-limit) on a real chunk-manager mirror would return the manager's own
  bytecode as garbage file bytes and pre-empt later mirrors. The fallback now triggers only
  when the call returned `0x` (viem `ContractFunctionZeroDataError`/`AbiDecodingZeroDataError`);
  transport/RPC errors propagate as a failed attempt so the fetch engine tries the next mirror.
