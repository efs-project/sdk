# Architecture Decision Records

ADRs document **decisions** made about the EFS SDK — what we chose, why, and what we considered. They are the institutional memory that survives turnover (human or agent).

This is the **same ADR system as the [contracts repo](https://github.com/efs-project/contracts/blob/main/docs/adr/README.md)** — a lightweight, MADR-style markdown ADR (`Context` / `Decision` / `Consequences` / `Alternatives`). Mirrored deliberately, so agents moving between repos don't learn two conventions. It is intentionally **lighter** here. The SDK is the *upgradeable* layer: we ship, observe, and revise. There is no frozen-schema-UID equivalent, so there is no 50-year freeze ceremony. Most SDK ADRs are freely revisable.

Numbering is **independent** from contracts — SDK ADRs start at `0001` in their own sequence.

## Status legend

- **Proposed** — under discussion, not yet acted on.
- **Accepted** — currently in force. Code reflects this decision.
- **Superseded by ADR-NNNN** — replaced by a later decision. The superseded ADR is preserved unmodified; the link points to the replacement.
- **Rejected** — considered and explicitly chosen against. Preserved so the option isn't reconsidered without learning from the prior thinking.
- **Deprecated** — no longer the right choice but not yet replaced. May indicate a known wart.

## Discipline (lighter)

The SDK is the *upgradeable* layer — almost nothing is permanent. The one thing that approaches it is the **published npm API**: breaking an exported signature is a semver-major with a migration cost, so supersede-don't-edit the deciding ADR and note the migration. Everything else (internal code, tooling, tests, prose) ships simple and is revised freely.

ADRs are **immutable once `Status: Accepted`**, but the bar to supersede is low:

1. Write a new ADR with the new approach.
2. Set the old ADR's `Status` to `Superseded by ADR-NNNN`. Touch nothing else in it.
3. The new ADR's Context explains why the old one fell short.

That's the whole ceremony — no 50-year test, no freeze gate. Supersede freely; the chain of reasoning is the only thing we protect. Prose-level fixes (typo, stale link) to an accepted ADR are fine in place; only the `Decision` / `Consequences` / `Alternatives` substance must change via supersession.

## When to write one

An ADR is for **a choice with alternatives you'd want preserved** — package layout, a dependency, the error model, a public-API shape. A routine code change with no real fork is not an ADR. The test: would a future agent ask *"why did they do it this way?"*

## Boundary rule — does this belong here?

- **SDK ADR** (this folder): decisions scoped to the SDK alone — package/monorepo layout, viem-vs-ethers, error model, public API shape, dependency choices and bumps, build/bundling, codegen.
- **Planning vault design** (`planning/Designs/`): any decision that changes EFS *architecture* or touches the **contracts** or **client** repos. Cross-repo concerns are designed in the vault; a landed design may then produce a per-repo SDK ADR here for the SDK's slice.
- **Not** `planning/Decisions.md`: SDK code decisions live in SDK ADRs, never in the vault's decisions log. The vault log is for cross-repo coordination calls, not this repo's implementation choices.

When unsure which side of the boundary a decision sits on, ask before writing — a misfiled ADR is worse than a late one. Worked example: *"change the schema UID the Solidity SDK pins"* touches the protocol → it originates as a planning-vault design, which then spawns an SDK ADR for the SDK's slice (the version bump + import change). *"Switch the bundler to tsdown"* is SDK-only → an ADR here.

The cross-cutting SDK architecture lives in the planning vault: `planning/Designs/sdk-architecture.md`. ADRs here implement slices of it. For *how the SDK behaves* (not why), see [`docs/specs/`](../specs/).

## Format & numbering

Compact, scannable — one screen per ADR. Copy `_template.md`. The next number is the highest existing `NNNN` + 1; add your ADR to the **Index** below (and remove it from "Recommended next" if listed).

## Index

- [ADR-0001 — Monorepo layout, packages & toolchain](./0001-monorepo-layout-and-toolchain.md)
- [ADR-0002 — viem-only; do not depend on the ethers-based EAS SDK](./0002-viem-only-no-eas-sdk-dependency.md)
- [ADR-0003 — Ship the on-chain SDK as compile-in Solidity source](./0003-onchain-sdk-as-compile-in-source.md)

_Recommended next: ADR-0004 error model · ADR-0005 public API surface & semver policy (write when the code lands)._
