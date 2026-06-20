/**
 * Vendored creation bytecode for `EFSBytesStore` — the deployable on-chain
 * chunk-manager the SDK deploys per on-chain-stored file (see `writes/onchain.ts`).
 *
 * Source of truth: the contracts repo artifact for the deployable chunk-manager.
 * The contract is a deployable `EFSBytesStore(address[] chunks)` exposing
 * `chunkCount()` + `chunkAddress(i)` — exactly the `IChunkedSSTORE2` interface
 * `EFSRouter` probes (EIP-7617 chunk pagination). The router reads by interface,
 * not by name, so the deployed bytecode is functionally name-independent. Vendoring
 * the compiled creation bytecode keeps the SDK a pure client (ADR-0005): it deploys
 * the store itself via `walletClient.deployContract`, no contracts-side factory
 * required.
 *
 * AGENT-NOTE: re-vendor MOCK→EFS_BYTES_STORE bytecode from the official
 * `EFSBytesStore` artifact once the contracts repo renames the contract (pending
 * freeze-agent task). The current creation bytecode is the existing `MockChunkedFile`
 * compile, kept verbatim — it is functionally identical (the router probes the
 * `IChunkedSSTORE2` interface, never the contract name), so only the vendored
 * artifact source needs swapping, not the bytes. The bytecode is solc-deterministic
 * for a fixed source + compiler settings, so it only changes if the contract source
 * changes.
 */

import type { Hex } from 'viem'

export const EFS_BYTES_STORE_BYTECODE: Hex =
  '0x60806040523461013f57610274803803806100198161015a565b92833981019060208183031261013f578051906001600160401b03821161013f570181601f8201121561013f578051916001600160401b038311610144578260051b9160208061006a81860161015a565b80968152019382010191821161013f57602001915b81831061011f576000845b80518210156101115760009160018060a01b0360208260051b84010151168354680100000000000000008110156100fd57600181018086558110156100e957602085806001969752200190838060a01b0319825416179055019061008a565b634e487b7160e01b85526032600452602485fd5b634e487b7160e01b85526041600452602485fd5b60405160f490816101808239f35b82516001600160a01b038116810361013f5781526020928301920161007f565b600080fd5b634e487b7160e01b600052604160045260246000fd5b6040519190601f01601f191682016001600160401b038111838210176101445760405256fe6080806040526004361015601257600080fd5b60003560e01c9081632bfedae0146053575063f91f093714603257600080fd5b34604e576000366003190112604e576020600054604051908152f35b600080fd5b34604e576020366003190112604e576004359060005482101560a857600080527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563909101546001600160a01b03168152602090f35b634e487b7160e01b600052603260045260246000fdfea26469706673582212206ea2dc51d432b7722a3857f0e86c67aaa8fa760e9dee9a8bbd7f8fac66eade7f64736f6c634300081c0033'
