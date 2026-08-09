# ADR-0005: Ship a per-chain deployments registry; the SDK is a client, not a deployer

**Status:** Accepted
**Date:** 2026-06-10
**Related:** ADR-0002, ADR-0003, planning/Designs/sdk-architecture.md (Instantiation)

## Context

The SDK reads/writes EFS, which lives in deployed contracts (EAS + the EFS resolvers/views) with registered schema UIDs. To talk to a chain, the SDK needs those addresses and UIDs. The SDK itself is **not deployed** — it's a client library that consumers run inside their own projects on whatever chain they target. So the open question is: how does the SDK know *where* EFS is?

## Decision

The SDK ships a **maintained per-chain deployments registry** and resolves addresses from it. It deploys nothing.

- A `deployments` map keyed by `chainId` holds the EAS + EFS contract addresses and the **frozen schema UIDs** for each supported chain.
- `createEfsClient({ publicClient, walletClient })` infers `chainId` from the viem client and looks up the registry. Supported chain → works with zero address config.
- An **override** (`createEfsClient({ ..., deployments: customMap })`) points the SDK at a custom or local deployment (a contributor's anvil, a private chain).
- **Integration tests fork a registry chain** — `anvil --fork-url <chain>` — the same approach the contracts repo uses. The fork carries the real addresses, so the registry is exercised unchanged. We do **not** reimplement EFS's CREATE3/proxy deploy locally.
- Source of truth for the registry data is the contracts repo's `FREEZE_LEDGER` / `deployedContracts.ts`. The SDK mirrors it and updates when EFS deploys to a new chain.

## Consequences

- **Consumer friction is minimal** — one line for a supported chain, an escape hatch for custom deployments. Their project/run setup stays their concern.
- **Low maintenance** — EFS addresses are CREATE3-deterministic and frozen, so the registry is append-only and stable, not churny. Adding a chain is a data change, not a code change.
- **Pre-deploy reality** — until a chain's EFS is live (Sepolia is gated on the freeze sign-off), its registry entry doesn't exist; unit tests cover pure logic until then, and integration tests light up when the fork target exists.
- The registry must be kept in sync with contracts deploys — a small, well-bounded sync task tied to the (rare) event of a new chain deployment.

## Alternatives considered

- **Require consumers to pass all addresses** — rejected: high friction and error-prone for the 99% case (a known chain).
- **Resolve addresses from an on-chain registry / ENS at runtime** — rejected for v1: extra round-trips for data that is static and frozen; a shipped map is simpler and offline-friendly. Could revisit if cross-chain discovery ever needs it.
- **Reimplement EFS deploy locally for integration tests** — rejected: forking the real chain is simpler, higher-fidelity, and toolchain-agnostic.
