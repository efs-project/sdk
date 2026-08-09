# ADR-0002: viem-only; do not depend on the ethers-based EAS SDK

**Status:** Accepted
**Date:** 2026-06-10
**Related:** ADR-0001, planning/Designs/sdk-architecture.md (the `EFS.EAS` exposure)

## Context

The TypeScript SDK reads and writes EFS data, which lives in **EAS attestations**. The obvious move is to wrap EAS's own SDK, `@ethereum-attestation-service/eas-sdk`. But that package (verified `2.9.1`, May 2026) still has a **hard dependency on `ethers@^6`**. Meanwhile the modern EVM-client standard — viem/wagmi — is what EFS's consumers (and the EFS client app) use.

Depending on `eas-sdk` would drag `ethers` into every consumer's bundle, create two provider/signer models side-by-side (an ethers `Signer` next to the app's viem `WalletClient`), and risk version skew. The thing we actually need from EAS is thin: ABI-encode schema data and build `attest` / `multiAttest` / `multiRevoke` calldata.

## Decision

**Standardize on viem end-to-end. Do not depend on `eas-sdk` or `ethers`.**

- Vendor the EAS contract ABIs and call them through viem (`writeContract`, `readContract`, `encodeAbiParameters`).
- Re-implement the small pieces we need from `eas-sdk` (the `SchemaEncoder` equivalent via `encodeAbiParameters`; UID derivation via viem `keccak256`/`encodePacked` when we need to predict/verify one).
- `viem` is a **peerDependency** (`^2`) so the consumer app has a single viem instance — wagmi's stance. No hard `viem` dep, no `ethers` anywhere.
- If we ever need EAS's offchain/Merkle helpers, isolate them in an optional `@efs/eas-adapter` sub-package so `ethers` stays strictly opt-in and out of the core dep tree.

This refines the planning design's `EFS.EAS` namespace: it exposes **EAS access via viem**, not a re-export of the ethers-based `eas-sdk`.

## Consequences

- Zero `ethers` in the dependency tree → smaller bundles, tree-shakeable, one provider model, no dual-signer confusion.
- We own EAS calldata construction and must track EAS ABI changes ourselves — a small, well-bounded surface (a handful of functions). Worth it; this is wagmi's own "typed ABIs over wrapper SDKs" philosophy, and Solady/solmate show "own the minimal primitive" beats "drag a heavy dependency."
- `EFS.EAS` (per the design) is provided as viem-native helpers + the vendored ABIs, not `import { EAS } from '@ethereum-attestation-service/eas-sdk'`.
- Because the chain client is visible in the public API (clients, accounts, returned types), this is **Durable** — switching off viem later would be a semver-major break.

## Alternatives considered

- **peerDep `eas-sdk` (+ ethers)** — rejected: forces ethers on all consumers and the dual-signer conflict with their viem `WalletClient`.
- **Adapter layer translating viem↔ethers** — rejected for the core path: more surface than just owning the few EAS ABIs; kept as the opt-in `eas-adapter` escape hatch only.
- **Wait for `eas-sdk` to drop ethers** — rejected: building on a deprecated path now to maybe migrate later is the worse bet; the calldata we need is trivial to own today.
