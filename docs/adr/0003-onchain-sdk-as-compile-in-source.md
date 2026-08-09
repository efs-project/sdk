# ADR-0003: Ship the on-chain SDK as compile-in Solidity source

**Status:** Accepted
**Date:** 2026-06-10
**Related:** ADR-0001, planning/Designs/sdk-architecture.md (On-chain SDK section)

## Context

The on-chain SDK lets a developer's *own* contract read and write EFS. EFS keys all content by **attester address** (lenses, cardinality-1 PINs). That attester is whatever address EAS sees as `msg.sender`. So the SDK must execute **in the consuming contract's context** — if it were a separately deployed helper that the consumer `CALL`s, the *helper* would be `msg.sender`/attester, collapsing every consumer into one identity (the same attribution bug the TS batch design avoids).

A library of `internal` functions inlines into the caller; an inheritable base contract runs in the child's context. Both preserve `msg.sender`. A plain `CALL` to a deployed contract does not.

## Decision

Ship the on-chain SDK as **Solidity source compiled into the consumer**, not as a deployed contract:

- `@efs/solidity` publishes `.sol` **source files only** (no bundling, no deploy artifacts), exactly like `@openzeppelin/contracts`.
- Two entry shapes: an `internal` **library** (`EFSLib`) for drop-in helpers, and an inheritable **base contract** (`EFSWriter`) for the happy path. Both keep the consuming contract as attester.
- **Tooling: Foundry** for building and testing the library (fast Solidity unit tests; `vm.prank` to prove `msg.sender` survives inlining). The sibling `contracts` repo uses Hardhat; a non-deployed library is better served by Foundry, and the published source is toolchain-agnostic for consumers.
- Consumption:
  - **Hardhat:** `npm i @efs/solidity`, then `import "@efs/solidity/src/EFSWriter.sol";` (resolved via `node_modules`).
  - **Foundry:** install, then `remappings.txt`: `@efs/solidity/=node_modules/@efs/solidity/`.

## Consequences

- Consumers pin the EFS interface/schema-UID constants by package version; no runtime coupling to a deployed helper.
- We must keep the published `.sol` API (the `EFSWriter` base methods, `EFSLib` signatures, hardcoded schema UIDs) stable across patch/minor — it's **Durable** across the npm boundary. Schema-UID changes in the protocol are a coordinated major bump here.
- A consumer's `msg.sender` is preserved, so attester-keyed lenses and cardinality work correctly without the consumer thinking about it.
- Tests live in `packages/solidity/test/*.t.sol` and are **not** published (`files` allowlist ships `src/**/*.sol` only).

## Alternatives considered

- **Deployed singleton helper the consumer calls** — rejected: makes the helper the attester (identity collapse). This is the load-bearing reason for the library form.
- **Hardhat for the SDK's Solidity package** (parity with `contracts`) — rejected: Foundry gives faster library unit tests and ergonomic `msg.sender`/inlining assertions; published source is consumer-toolchain-agnostic regardless.
- **Precompiled artifacts / bytecode** — rejected: a compile-in library has no standalone bytecode to ship; source is the artifact, and it lets the consumer's compiler pin the pragma.
