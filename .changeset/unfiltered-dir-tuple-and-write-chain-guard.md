---
"@efs/sdk": patch
---

Two write/read correctness fixes:

- **(P1) `efs.fs.list('/dir')` no longer throws on a real chain.** `getDirectoryPageByAddressList`
  declares TWO top-level ABI outputs (`items`, `nextCursor`), so viem decodes its return as a
  positional tuple, not an object — the unfiltered directory path read `.items` off the tuple
  (`undefined`) and threw before returning any entries. Now destructured positionally. (The
  filtered/by-schema siblings wrap their values in one `DirectoryPage` struct and were unaffected.)
  The unit-test mocks were returning an object, masking this; they now return the tuple shape real
  viem produces.

- **(P2) `fs.write`/`fs.setOverview` fail closed on a wallet/public-client chain mismatch.** The EFS
  deployment (addresses + schema UIDs) is resolved from the public client's chain, but writes run on
  the wallet's chain. A `ViemConfig` with a wallet bound/connected to a different chain than the
  public client would send the EAS/storage txs to the wrong chain's contracts (and await receipts on
  the public chain). The SDK now asserts the wallet chain equals the deployment chain before any tx,
  throwing a typed `WrongChain` error (added to the public `EfsErrorCode` union).
