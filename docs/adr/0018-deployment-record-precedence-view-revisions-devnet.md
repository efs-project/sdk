# ADR-0018: Deployment record precedence, view revisions, and the devnet entry

**Status:** Accepted
**Date:** 2026-08-07
**Related:** extends ADR-0012 (freeze-table sourcing; ADR-0005's `deployedContracts.ts` sourcing sentence is dead), contracts issues [#43](https://github.com/efs-project/contracts/issues/43) (generated manifest) and [#44](https://github.com/efs-project/contracts/issues/44) (WHITEOUT status honesty), SDK PR #1 review r3739110412

## Context

The registry carried the pre-June-23 Sepolia view trio: `deployedContracts.ts` — the file the SDK copied from — was itself stale, while the hardhat deployment artifacts and `docs/CHAINS.md` both carried the hardened redeploy (ADR-0057/0058/0059). Old view deploys keep their bytecode, so the code-exists gate passed on the stale addresses; only the ROUTER's code actually changed (old/new FileView and ListReader are byte-identical — verified by live readback), so the drift was behavioral and invisible. Separately, the built-in `DEVNET = { ...SEPOLIA, chainId: 26001993 }` entry is factually wrong on the live devnet: a 2026-08-07 probe found fork-local resolver proxies, no code at any Sepolia CREATE3 address, and a different `ANCHOR_SCHEMA_UID`; the fork pin (`FORK_BLOCK=10_691_000`) predates the freeze blocks, so the mirror-Sepolia design cannot currently hold.

## Decision

1. **Record precedence (pre-#43):** the built-in registry is seeded from the contracts repo's **hardhat deployment artifacts + `docs/CHAINS.md`** — which must agree — and NEVER from `deployedContracts.ts`. A CI drift gate (`scripts/check-deployment-drift.mjs`) enforces registry↔artifacts, registry↔CHAINS.md, and artifacts↔CHAINS.md separately (an upstream conflict fails distinctly — never silently pick one). The script is interim: delete it and consume the generated manifest when contracts#43 lands.
2. **Core/view split + view revisions:** `EfsContracts` stays flat (62 call sites untouched), but `CORE_CONTRACT_KEYS` (Safe-keyed CREATE3 permanents + EAS singletons) and `VIEW_CONTRACT_KEYS` (stateless redeployables in no schema UID) make the split structural, and each deployment may pin an `EfsViewRevision` — revision id + **runtime codehashes from a live readback** (#44's "a recorded readback supports every live claim"). `verifyDeployment` gains `assertViewRevision`: keccak256 of live code must match the pin. Honest limits documented: byte-identical redeploys are undetectable (and harmless); "a newer canonical revision exists" is the drift-CI's job, not a runtime check; core proxy implementations are deliberately unpinned pre-burn. The full nested `contracts: {core, views}` type split is deferred to manifest adoption — the shape then breaks once, against the final schema.
3. **DEVNET removed from the built-in map** (`DEVNET_CHAIN_ID` kept as a documented constant; `resolveDeployment(26001993)` throws `DeploymentNotFound` with a devnet-specific hint naming the override). A built-in entry that cannot serve one successful call is worse than a clear error. It returns when the devnet is re-provisioned to genuinely mirror Sepolia (Safe-keyed CREATE3 ceremony + deterministic views) or contracts#43 ships an independently-generated devnet profile — which of those is the plan is an open owner question.
4. **Feature gating (the #44 rule):** SDK feature availability is NEVER inferred from an ABI existing. Future additive features (WHITEOUT, SORT_INFO) enter `EfsContracts`/`EfsSchemaUIDs` as OPTIONAL keys gated on per-chain deployment status (from the #43 manifest's `implemented/deployed/registered/wired` enum once it exists), and invoking an unavailable feature throws a typed error naming the chain and status. A tripwire test pins the current no-WHITEOUT state and points here.

## The SDK's manifest wishlist (the ask on contracts#43)

Per-chain profile `{ chainId, profileRevision, sourceCommit }`; core addresses + governance/burn status, separate from view revisions with deploy block + **readback** runtime codehash + capability list; schemas as `{ uid, byte-exact field string, revocable, resolver, authoritative getter }` (derivable `EFS_SCHEMA_FIELDS` + integrity-gate source map); per-scheme `/transports/<scheme>` anchor UIDs (unblocks the `MissingTransport` gap); per-feature status enum; an INDEPENDENT devnet profile with a reset policy (post-reset regeneration or deterministic view deploys); distribution preferably as a versioned `@efs/deployments` package generated from repo JSON.

## Alternatives considered

- **Keep DEVNET seeded (frictionless on-ramp)** — rejected: every call fails against the live devnet; a clear error beats a fake on-ramp. The hackathon that motivated it also wound down.
- **Nested `contracts: {core, views}` now** — deferred: ~62 call sites of churn against a shape #43 will redefine anyway.
- **Pin implementation codehashes behind the core proxies** — rejected pre-burn: legitimate Safe upgrades would false-positive; revisit as a burn-status check when #43 carries governance fields.
