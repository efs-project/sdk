# AGENTS.md

The **EFS SDK** — the developer-facing SDK for the Ethereum File System (an on-chain filesystem on EAS attestations). This repo ships two packages: a TypeScript SDK and a compile-in Solidity SDK. Pre-1.0, pre-launch — breaking changes are fine for now; good design and future-proofing of the *public surface* is what matters.

This is the **upgradeable** layer of EFS (vs. the immutable contracts). Ship the simple version, observe, revise.

## Read on init

**If your tool does not auto-load `@`-imported files, read these before starting any task:**

- **[docs/specs/overview.md](./docs/specs/overview.md)** — plain-language *how the SDK works* (the model). Start here to understand behaviour.
- **[docs/adr/README.md](./docs/adr/README.md)** — the ADR system and the **boundary rule** (SDK ADR vs. planning-vault design). Required before writing a decision.
- **[README.md](./README.md)** — what the two packages are and how they're consumed.

Doc layers (don't duplicate): **specs** = how it works now · **ADRs** = why we chose it · **planning vault** = cross-cutting design. See [docs/specs/README.md](./docs/specs/README.md).

## The two packages

- **`packages/sdk`** → `@efs/sdk` — TypeScript, off-chain reads/writes, viem-native (ADR-0002).
- **`packages/solidity`** → `@efs/solidity` — a compile-in Solidity library (ADR-0003); your contract stays the attester.

## Cross-repo coordination — the planning vault

The cross-cutting SDK architecture lives in the **planning vault**, not here: `planning/Designs/sdk-architecture.md` (the "what + why"), plus `planning/Designs/sdk-minimal-clicks.md`. This repo's ADRs implement *slices* of that design.

**Boundary rule (see [docs/adr/README.md](./docs/adr/README.md)):**
- SDK-only decision (package layout, deps, error model, API shape) → an **SDK ADR** here.
- A decision that changes EFS *architecture* or touches the **contracts**/**client** repos → a **planning-vault design**, not an SDK ADR.
- SDK code decisions never go in `planning/Decisions.md` (that's for cross-repo coordination only).

The sibling repos: protocol contracts (`efs-project/contracts`) and the production client (`efs-project/client`).

## Conventions

- **ADRs:** mirror the contracts repo's format, independent numbering from `0001`, lighter discipline (no freeze ceremony). Supersede-don't-edit accepted ADRs.
- **Commits:** conventional style (`feat:`, `fix:`, `docs:`, `adr:`, `chore:`).
- **Quality:** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` before a PR. Every change that touches a published package needs a Changeset (`pnpm changeset`).
