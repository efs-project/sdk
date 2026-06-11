# Ethereum standards the SDK is built on

> The EFS SDK is anchored on **EIPs / ERCs / CAIPs** (durable, peer-reviewed, multi-decade) rather than library quirks (viem/ethers are ~10-year tools; the standards outlast them). Researched 2026-06-11 via a 7-domain web-search pass (EIP repos, ethereum-magicians, EthResearch, viem docs). Each standard is tagged **ADOPT** (build on it now) · **SEAM** (reserve the hook, don't build yet) · **WATCH** (re-check quarterly) · **AVOID**.

## The one principle

**Depend on the standard, use viem as the engine.** The durable boundary is the standard's shape (an EIP-1193 `request` provider, an EIP-712 struct, a `web3://` URL); viem is the best *implementation* of those today and is swappable behind the boundary. We never make viem's concrete types the public contract.

## Provider & wallet

| Standard | Status | SDK | Note |
|---|---|---|---|
| **EIP-1193** Provider JS API (`request`/events/error codes) | Final | **ADOPT** | The universal wallet contract. Public boundary = a minimal `{ request }` shape, not viem's `EIP1193Provider` import; adapt to viem via `custom()` internally. |
| **EIP-1193 error codes** (4001 user-rejected, 4100 unauthorized, 4200, 4900/4901) | Final | **ADOPT** | Error model must recognize these; 4001 is benign (user rejection), not a failure. |
| **EIP-1474** JSON-RPC + `-327xx`/`-32000..099` codes | Stagnant | **ADOPT** (codes) | Cite for the error taxonomy, not as a living spec. |
| **EIP-2255** Wallet permissions (`wallet_requestPermissions`) | Final | **SEAM** | Call through the `request` seam when consent is needed; don't build a permissions layer. |
| **EIP-6963** Multi-injected provider discovery | Final | **IGNORE** (app concern) | Wallet *selection* is the connector/app's job; we consume the chosen 1193 provider. Optionally re-export `mipd`. |

## Batching & account abstraction

| Standard | Status | SDK | Note |
|---|---|---|---|
| **EIP-5792** `wallet_sendCalls` / `wallet_getCapabilities` | **Final** | **ADOPT (primary)** | The standards-blessed one-signature multi-call. MetaMask 12+, Coinbase, Safe, viem `sendCalls`/`getCapabilities` + `experimental_fallback`. Batched calls execute from the user's address → **attester preserved**. |
| **EIP-7702** EOA→smart-account delegation | **Live (Pectra, May 2025)** | **SEAM (detect)** | The engine behind 5792's `atomic: ready` for plain EOAs. Don't implement it; let the wallet drive. Address unchanged → attester intact. |
| **ERC-4337** Account abstraction | Final (EntryPoint v0.7/0.8) | **IGNORE** | If the user has a 4337 account, `wallet_sendCalls` abstracts it — don't hand-roll UserOps/bundlers. |
| **EIP-7677** Paymaster web service | Draft | **SEAM** | A 5792 capability (`paymasterService`) for gasless writes later. |
| **EIP-7715** `wallet_grantPermissions` / session keys | Draft | **WATCH** | Future signature-free repeated writes. Fast-moving. |
| **ERC-7579 / ERC-6900** Modular smart accounts | mixed | **IGNORE** | Account-implementation altitude, below an RPC client. |

**Write-path rule:** `wallet_sendCalls` primary (gated on `getCapabilities` → `atomic`), sequential `eth_sendTransaction` fallback (viem `experimental_fallback`). Only set `atomicRequired` when capabilities confirm it; **otherwise design for partial writes** (content-addressed chunks + a final commit attestation).

## Signatures & verification

| Standard | Status | SDK | Note |
|---|---|---|---|
| **EIP-712** Typed structured data | Final | **ADOPT** | Every EAS delegated request. Pin the domain exactly: `verifyingContract` = the EAS/proxy address, correct `chainId`, EAS's own `name`/`version`. Domain mismatch is failure mode #1. |
| **EIP-1271** Contract-wallet `isValidSignature` | Final | **ADOPT** (verify) | Never `ecrecover` off-chain — route through a 1271-aware path. |
| **ERC-6492** Counterfactual-wallet signatures | Final | **ADOPT** | Coinbase Smart Wallet emits these. **viem's `verifyTypedData`/`verifyMessage` *Actions* handle 1271 + 6492 (+ 8010) automatically** — use those, never the EOA-only util. |
| **ERC-2098** Compact (64-byte) signatures | Final | **SEAM** | Accept both 64- and 65-byte forms in the verify/normalize seam. |
| **EIP-7739** Nested/readable typed sigs (cross-account replay) | Draft | **WATCH** | Real but not adoption-critical; viem ships it experimental. Don't emit wrappers yet; don't block it. |

**Replay defenses to implement regardless:** per-EAS `nonce`, `deadline`, and domain-bound `chainId` + `verifyingContract` (kills cross-chain + cross-contract replay).

## Identity & naming (ENS)

| Standard | Status | SDK | Note |
|---|---|---|---|
| **ENSIP-15** Name normalization | Final | **ADOPT** | `normalize()` every input before resolving (viem). Skipping it = wrong namehash + spoof risk. |
| **ENSIP-10** Wildcard resolution + **Universal Resolver (ENSIP-23)** | Final | **ADOPT** | The single resolution entrypoint (viem `getEnsAddress`/`getEnsName`/`getEnsText`). Never hand-roll registry traversal. |
| **EIP-3668** CCIP-Read (offchain lookup) | Final | **ADOPT** (ENS) / **SEAM** (general) | Keep enabled so L2/offchain ENS names resolve; allow `gatewayUrls` override. The same seam serves our future offchain "key-sets." |
| **ENSIP-5/12/18** Text records (avatar/url/socials) | Final | **ADOPT** (lazy read) | Curated allowlist; namespace EFS keys as `xyz.efs.*`. |
| **ENSIP-19** Multichain primary names (reverse) | Final (L2 rollout 2025) | **WATCH→ADOPT** | `getEnsName` (forward-verified); thread coinType for L2 primaries as viem stabilizes. |
| **ENSv2 / Namechain** | alpha; now **L1, not an L2** (Feb 2026 reversal) | **WATCH** | Universal Resolver seam absorbs the registry swap. The one fast-mover to recheck before GA. |

## Content addressing, storage & web3 URLs

| Standard | Status | SDK | Note |
|---|---|---|---|
| **ERC-4804** `web3://` URL → EVM call | Final | **ADOPT** | Base scheme for MIRROR URIs. |
| **ERC-6860** web3:// clarification | Draft (de-facto live) | **ADOPT** | Implement to 6860 semantics. Fast-moving. |
| **ERC-6944** ERC-5219 resolve mode (`resolveMode()=="5219"`) | Draft | **ADOPT** | EFS's on-chain content path: decode `(uint16 status, string body, KeyValue[] headers)`. **No library does web3:// — our mirror layer owns it.** |
| **ERC-6821** ENS → contract for web3:// (TEXT record, not `contenthash`) | Draft | **SEAM** | Don't assume `contenthash` for web3:// ENS. |
| **ERC-7774** Cache invalidation (ETag) in 5219 | early | **WATCH** | When we cache on-chain fetches. |
| **SSTORE2** On-chain byte storage | pattern (not an EIP) | **ADOPT** | Chunked across data-contracts (24 KB code-size cap); concatenation/ordering is EFS-level. |
| **EIP-4844** Blobs | Final | **AVOID** (for files) | Pruned ~18 days — DA primitive, not durable storage. |
| **data: URIs** (RFC 2397) | Final | **SEAM** | A fetch scheme for tiny inline content. |
| **CID / multihash** (IPFS) | living (multiformats) | locator-only | **CID ≠ `sha256(file bytes)`** for multi-chunk files (Merkle-DAG root). Verify on our own `contentHash`; treat CIDs as locators (ADR-0006). |

## Chain / address interop & errors

| Standard | Status | SDK | Note |
|---|---|---|---|
| **EIP-155** chainId | Final | **ADOPT** | Registry key (canonical, viem-native). |
| **CAIP-2 / CAIP-10 / CAIP-19** chain/account/asset IDs | Stable (CASA) | **ADOPT** (boundary) / **SEAM** | De-facto "which chain + which account" (`eip155:1:0x…`). Speak it at the boundary behind a `chainId↔CAIP` seam — also the on-ramp for non-EVM + ERC-7930. |
| **ERC-3770** chain-prefixed addresses (`eth:0x…`) | Stagnant | **WATCH** | Accept-on-input only; not a storage format. |
| **ERC-7930 / ERC-7828** Interoperable addresses | Review (2025) | **WATCH** | Strategic successor; behind the address seam. Recheck quarterly. |
| **EIP-3085/3326** add/switch chain (`4902`) | Final/Review | **SEAM** | Only in the wallet-facing path (viem `addChain`/`switchChain`). |
| **Solidity revert decoding** (`Error(string)`, `Panic(uint256)`, custom selectors) | spec | **ADOPT** | Build the error model as a **classifier over viem's `BaseError` tree** — `walk()` → `ContractFunctionRevertedError`, decode with the EAS ABI. Don't reimplement. |

## Attestation, metadata, encoding & conventions

| Standard | Status | SDK | Note |
|---|---|---|---|
| **EAS** (SchemaRegistry + EAS, EIP-712-backed) | de-facto standard (not an ERC) | **ADOPT (substrate)** | Ride EAS directly; no ratified attestation ERC exists or is imminent. Keep an EAS-resolution seam. `expirationTime`/`revocable`/`refUID` are first-class — use them, don't invent parallels. |
| **Solidity ABI** (`abi.encode`, not `encodePacked` for hashed/signed data) | spec | **ADOPT** | SchemaEncoder uses typed `abi.encode` (length-prefixed, collision-safe). |
| **EIP-1559** fee fields (`maxFeePerGas`/`maxPriorityFeePerGas`) | Final | **ADOPT** | Set via `feeHistory` + buffered estimate; expose a per-batch override seam. Never legacy `gasPrice`. |
| **ERC-7572** `contractURI()` contract-level metadata | canonical | **SEAM** | A self-description shape for EFS folders/lenses/lists. |
| **ERC-8048 / ERC-8049** Onchain key-value metadata + indexed events | Draft | **WATCH** | The standards most likely to converge with EFS **properties** — design properties expressibly through this shape. |
| **Token Lists** (tokenlists.org) | community standard | **ADOPT (pattern)** | Versioned, identity-hosted JSON — the template for EFS **lists** serialization. |
| **ERC-7208 / 7813** Onchain data containers / tables | Draft/near-Final | **WATCH** | Architecturally parallel to EFS's attestation-rows model. |
| **ERC-7512 / 5851 / 8273** attestation/credential/agentic | Draft | **IGNORE/WATCH** | Off-target (audits/credentials/agents), not file attestations. |

## What this changes in the foundation (actionable)

1. **Provider boundary → EIP-1193.** Widen `EfsReader`/`EfsWriter` to accept a minimal EIP-1193 `{ request }` provider (or a viem client), normalized to viem internally via `custom()`. *This is the "depend on the standard, not the library" upgrade — the single highest-leverage durability change.*
2. **Batch path → EIP-5792 primary** (it's now Final): `getCapabilities` → `wallet_sendCalls` (atomic when supported), sequential fallback; design for partial writes. Updates the Q5 design; `WriteMechanism` already includes `eip5792`.
3. **Error model = classifier over viem `BaseError`** decoding `Error`/`Panic`/custom selectors (EAS ABI) + RPC codes (4001/4902). Refines ADR-0007.
4. **Verification = viem verify Actions** (1271/6492/8010) behind one `verifySignature` seam; accept ERC-2098 compact sigs.
5. **Identity = ENSIP-15 normalize → Universal Resolver + CCIP-Read**, all via viem; expose CCIP-Read as a generic offchain-lookup seam (for key-sets).
6. **Mirror layer owns `web3://`** (ERC-4804/6860 + ERC-6944) — no library provides it; our core value-add. Verify content on `contentHash`, CIDs are locators.
7. **CAIP-2/10 seam** at the chain/address boundary; **EIP-1559** fee handling on writes; **ERC-7572-shaped** self-description + **Token-Lists pattern** for lists.

## WATCH list (re-check ~quarterly)
EIP-7702 wallet support · EIP-5792 capability evolution · EIP-7715 session keys · ERC-7930/7828 interoperable addresses · ENSv2 registry · ERC-8048/8049 onchain metadata · ERC-7774 cache · ERC-7739 nested sigs.

## AVOID
`web3.js` (archived) · `eth_sign` (blind-signing) · legacy `gasPrice` · `encodePacked` for hashed/signed data · EIP-4844 blobs for durable file storage · hand-rolled ERC-4337/UserOps · raw `ecrecover` for signature verification.
