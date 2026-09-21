# ADR-0008: Public API shape, instantiation & semver policy

**Status:** Accepted
**Date:** 2026-06-11
**Related:** ADR-0002 (viem), ADR-0007 (errors), ADR-0009 (library-agnostic seam), planning/Designs/sdk-architecture.md (Decision F)

## Context

The SDK's public surface is the one near-permanent thing it has (breaking it is a semver-major with downstream cost). A three-agent foundation review found the right instincts but two contradictions: the design doc specified `new EFSClient({ rpc, chainId })` while the code shipped `createEfsClient({ publicClient })`, and write capability was a runtime check rather than a type. This ADR locks the surface before publish.

## Decision

**Instantiation — a factory whose boundary is the standard (an EIP-1193 provider + EIP-155 chain); viem is the engine inside (ADR-0009).**

```ts
// Standard form (durable, library-neutral; any wallet is an EIP-1193 provider):
const efs = createEfsClient({ provider, chain, account?, deployments?, defaultLens? })
// Convenience form (viem-native callers):
const efs = createEfsClient({ publicClient, walletClient?, deployments?, defaultLens? })
```

- A **factory function**, not `new EFSClient` (viem/wagmi never expose `new PublicClient`).
- The public contract is the **EIP-1193 `request` interface** (`docs/specs/standards.md`), not viem's concrete types; the SDK wraps the provider with viem's `custom()` transport internally. This is the "depend on the standard, not the library" boundary.

**Resource-namespaced surface** (Decision F): `efs.fs` (files) · `efs.lenses` · `efs.eas` (viem-native) · `efs.raw` (deployment escape hatch). The full design's `graph`/`props`/`lists`/`sorts` namespaces are **additive** (a new top-level namespace is non-breaking) and land in a dedicated pass.

**Type-level write gate.** `createEfsClient` is overloaded: with a `walletClient` it returns the write-capable `EfsClient`; without, `EfsReadClient` (no `fs.write`/`preview`/`batch` in the type). `WalletRequired` is the runtime backstop (ADR-0007). This mirrors viem's `PublicClient`/`WalletClient` split — write capability lives in the type, not a runtime check.

**Future-proofing seams that exist now** (additive-now / breaking-later, so they're in the foundation before publish):
- **Named, exported option/return types** — `ReadOptions`/`ListOptions`/`FetchOptions`/`WriteOptions`, never inline literals (adding a field stays non-breaking).
- **Pagination** — `list` returns `EfsList<T>` (`AsyncIterable<T>` + `.page()`), with an exported `Page<T>`; a bare `AsyncIterable` can't grow `.page()` without a return-type change.
- **Batch** — `efs.batch()` + exported `BatchReceipt`/`OperationResult`/`WriteMechanism`; `fs.write` is documented as sugar over it.
- **Branded UIDs** (`DataUID`) + static `DataRef` vs dynamic `PathRef`.

**Semver policy.** The published API is the SDK's only Durable surface (per the ADR-process framing). Breaking an exported signature/type is a major. Pre-1.0 we may break freely; at 1.0 the above seams are frozen. Every change to a published package needs a Changeset stating the bump.

## Consequences

- The design doc's instantiation section is superseded by this (factory + injected viem clients); the two are reconciled.
- A read-only client cannot call write verbs at compile time — the highest-leverage type safety, cheap now.
- The option/pagination/batch seams mean the bulk of future feature work adds *optional fields* and *new namespaces*, not breaking changes.

## Alternatives considered

- **`new EFSClient({ rpc, chainId, signer })`** (the old doc shape) — rejected: not viem-idiomatic; raw rpc strings prevent custom transports/wallets.
- **Runtime-only write check** — rejected: a thrown error is strictly worse than a compile error; the type gate is free.
