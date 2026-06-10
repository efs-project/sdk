# ADR-0001: Monorepo layout, packages & toolchain

**Status:** Accepted
**Date:** 2026-06-10
**Permanence:** Ephemeral (internal structure) — the *package names* are Durable once published
**Related:** planning/Designs/sdk-architecture.md (Q1: both SDKs in one repo)

## Context

The EFS SDK ships two deliverables from one repo (`github.com/efs-project/sdk`): a **TypeScript SDK** (npm, off-chain reads/writes) and an **on-chain Solidity SDK** (a compile-in library). The planning design resolved Q1 — both live here because distribution, not deployment, is the deciding factor: the Solidity library is `npm install`-ed and compiled into a dev's own contract, exactly like `@openzeppelin/contracts`.

We need a layout that is clean for us (builders) and obvious for external devs, with a publishing story that works for both audiences.

## Decision

A **pnpm + Turborepo + Changesets** monorepo with two independently-versioned packages:

```
sdk/
├── packages/
│   ├── sdk/          → npm @efs-project/sdk        (TypeScript, off-chain)
│   └── solidity/     → npm @efs-project/solidity   (Solidity, compile-in source)
├── examples/         (foundry-consumer, hardhat-consumer, ts-quickstart)
├── docs/adr/         (this system)
├── pnpm-workspace.yaml, turbo.json, tsconfig.base.json, biome.json, .changeset/
```

- **Workspace manager: pnpm.** De-facto standard for 2025–2026 TS+Solidity monorepos (viem, wagmi); strict `node_modules` avoids phantom-dependency bugs. We override the sibling `contracts` repo's yarn/scaffold-eth convention — inheriting yarn isn't worth it here.
- **Task runner: Turborepo.** Caches build/test/typecheck across packages.
- **Two packages, versioned independently via Changesets.** The Solidity ABI and the TS API move on different cadences; lockstep would force no-op bumps and dishonest changelogs.
- **npm scope `@efs-project`** (matches the GitHub org; guaranteed claimable). If the shorter `@efs` org is secured on npm, rename both packages before first publish — it is a one-line change in each `package.json`, cheap pre-1.0.
- **Package name `@efs-project/solidity`, not `…/contracts`** — to avoid conceptual collision with the core protocol repo (`efs-project/contracts`). This SDK is a *library you compile in*, not the deployed protocol.

## Consequences

- External devs run `npm i @efs-project/sdk` (TS) or `npm i @efs-project/solidity` (Solidity source + remap). One repo, two clear install paths.
- Changesets gates every PR on a stated version intent; CI opens a "Version Packages" PR and publishes on merge.
- The package names cross the npm boundary, so they are **Durable** once published — renaming after external adoption is a breaking change. Hence the pre-publish window to settle `@efs` vs `@efs-project`.
- Toolchain specifics (bundler, test runner, lint) are recorded in ADR-0002+ and the package configs; they are Ephemeral and revisable.

## Alternatives considered

- **Single package** holding both TS and Solidity — rejected: the two have different consumers, toolchains, and release cadences; one version line couples them artificially.
- **yarn workspaces** (for parity with `contracts`) — rejected: consistency with a legacy scaffold doesn't outweigh pnpm's correctness and ecosystem momentum.
- **Two separate repos** — rejected by the design's Q1: they share docs, examples, and a coordinated story; one repo keeps them in sync.
