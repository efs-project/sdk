---
"@efs/sdk": patch
---

On-chain (zero-infra) writes now deploy the productionized **ERC-5219 `EFSBytesStore`**
instead of the old `MockChunkedFile`, so a bare `web3://<store>` URL for any
SDK-uploaded file resolves in any EIP-4804/6860/5219 client — not just via the EFS
router/SDK.

- Re-vendored `EFS_BYTES_STORE_BYTECODE` from the merged contracts artifact (solc 0.8.26,
  viaIR; validated by the contracts' 20 `EFSBytesStore` deploy tests).
- The deploy now uses the 2-arg constructor `EFSBytesStore(address[] chunks, string
  contentType_)`; the SDK threads the file's MIME (the same value bound as the
  lens-scoped `contentType` PROPERTY; empty ⇒ `application/octet-stream`) into the store.
- The on-chain reader (`mirror/web3.ts`) is unchanged — it keeps the direct
  `chunkCount`/`chunkAddress` + extcodecopy path for byte-for-byte parity with
  `EFSRouter.sol` (ADR-0013). No public TypeScript API change.
