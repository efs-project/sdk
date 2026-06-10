# Contributing

## Setup

```bash
pnpm install
```

Requires **pnpm 9+**, **Node 20+**, and **[Foundry](https://book.getfoundry.sh/)** (for `packages/solidity`).

## Commands

```bash
pnpm build       # build both packages (turbo)
pnpm test        # vitest (sdk) + forge test (solidity)
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome ci
pnpm format      # biome format --write
```

Per package: `pnpm --filter @efs-project/sdk test`, `pnpm --filter @efs-project/solidity build`, etc.

## Before you open a PR

1. `pnpm build && pnpm test && pnpm typecheck && pnpm lint` are green.
2. If you changed a **published package**, add a Changeset: `pnpm changeset` (pick the bump; write a one-line consumer-facing summary).
3. If you made a **decision** (a choice with alternatives), write an ADR — see below.

## Decisions → ADRs

Read [`docs/adr/README.md`](./docs/adr/README.md). The short version:

- A decision **scoped to the SDK** (package layout, deps, error model, public API shape) → a new ADR in `docs/adr/`, numbered from the next free `NNNN`, using `_template.md`.
- A decision that changes EFS **architecture** or touches the **contracts**/**client** repos → it belongs in the **planning vault** (`planning/Designs/`), not here.
- Accepted ADRs are immutable — to change one, write a new ADR and mark the old `Superseded by ADR-NNNN`.

The SDK is the upgradeable layer, so the ADR bar is light: same format as the contracts repo, no freeze ceremony.

## Style

- TypeScript: Biome (`pnpm format`); `strict` tsconfig; typed errors (extend `EfsError`), never raw RPC strings.
- Solidity: `forge fmt` (solhint planned).
- Commits: conventional (`feat:`, `fix:`, `docs:`, `adr:`, `chore:`).
