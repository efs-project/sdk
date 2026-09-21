# ADR-0009: Library-agnostic seam — viem core, ethers as an optional adapter

**Status:** Accepted
**Date:** 2026-06-11
**Related:** ADR-0002 (viem-only core), ADR-0008 (public API)

## Context

ADR-0002 made the SDK viem-native (vendored EAS ABIs, no ethers, no eas-sdk). The concern raised: don't get over-attached to one library — what if a consumer's codebase is ethers-based? A 2025–2026 landscape check (web-verified):

- Only **viem** and **ethers v6** are realistic EVM client libraries for a new SDK; web3.js is sunset. There is no third contender.
- **Wallets are not client libraries.** A wallet (MetaMask, WalletConnect, Coinbase, Rabby, Ledger, embedded/smart wallets) is an **EIP-1193 provider**; viem wraps *any* EIP-1193 provider via `custom()`. So "support multiple wallets" is already solved by viem — the only real axis of coupling is supporting a second *client library* (ethers).
- The EAS SDK itself went dual (ethers + viem) around mid-2025 — evidence the interop is worth offering.
- Well-regarded SDKs (e.g. thirdweb) keep a viem-native core and expose ethers interop as **subpath adapters** (`thirdweb/adapters/ethers6`), never bundling ethers into core.

## Decision

**The public boundary is the standard — an EIP-1193 provider + EIP-155 chain — and viem is the engine *inside* (ADR-0002 stands). This is implemented, not just seamed:**

1. **`createEfsClient` accepts the standard form `{ provider: EIP1193Provider, chain, account? }`.** Internally the SDK wraps the provider with viem's `custom()` transport and builds the viem clients it uses. The public contract is the EIP-1193 `request` interface (the durable standard, see `docs/specs/standards.md`), not viem's concrete types. A second **convenience form** `{ publicClient, walletClient? }` is accepted for viem-native callers; both normalize to viem internally.
2. **Reserve `@efs/sdk/ethers`** as the future optional adapter entry (`fromEthersSigner`/`fromEthersProvider` → a provider), with `ethers` as an optional peerDependency **only there** — never in the core dep tree.

This refines ADR-0002 ("viem-only") to **"standard boundary, viem engine, library-extensible."** Because the boundary is EIP-1193, **every wallet already works** (MetaMask/WalletConnect/Coinbase/hardware/embedded are all EIP-1193 providers), and swapping or adding a client library never breaks a consumer.

## Consequences

- **Every wallet works today** through viem's EIP-1193 wrapping — no SDK work needed for "multiple wallet types."
- **ethers users get a path later** (the adapter) without the core ever importing ethers, and without a major version bump.
- The cost now is two aliases + a reserved subpath — essentially free.
- If a genuinely new client library emerges, the same alias-widening + adapter-subpath pattern absorbs it.

## Alternatives considered

- **A full SDK-owned signer/provider interface with two adapters** — rejected as over-engineered for a one-library-today reality; the aliases give the same non-breaking future with far less surface.
- **EIP-1193-only core (drop viem)** — rejected: loses viem's typed encoding/contract layer and EIP-5792 batching actions.
- **Bundle ethers in core (dual like eas-sdk)** — rejected: drags ethers into every consumer's bundle, the exact coupling ADR-0002 avoided.
