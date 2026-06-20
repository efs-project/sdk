/**
 * Vendored `IChunkedSSTORE2` ABI — the EIP-7617 chunk-pagination interface the
 * canonical `EFSRouter` probes on a `web3://` target (the chunk manager the SDK
 * deploys via `EFSBytesStore`). Two reads:
 *
 *   - `chunkCount() -> uint256`        — how many SSTORE2 chunks the file spans.
 *   - `chunkAddress(uint256) -> address` — the SSTORE2 code-contract for chunk `i`.
 *
 * Mirrors the interface `EFSRouter.sol` declares (`interface IChunkedSSTORE2`,
 * EFSRouter.sol:20-23) and `staticcall`s in its `web3://` read branch. The SDK's
 * `web3://` read transport (`mirror/web3.ts`) calls these to enumerate the chunk
 * addresses, then code-copies each chunk and strips the leading `0x00` STOP byte —
 * the exact read the router performs on its own chain. Kept minimal: only the two
 * reads the read path needs.
 */

export const chunkedSstore2Abi = [
  {
    type: 'function',
    name: 'chunkCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'chunkAddress',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const
