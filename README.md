# EFS SDK

The developer SDK for the **Ethereum File System (EFS)** — an on-chain filesystem built on [EAS](https://attest.org) attestations.

> **Status: scaffold.** Repo structure, toolchain, and public API shapes are in place; implementations land next. Architecture: [`planning/Designs/sdk-architecture.md`](https://github.com/efs-project/planning). Decisions: [`docs/adr/`](./docs/adr).

## Two packages, two audiences

| Package | npm | For |
|---|---|---|
| [`packages/sdk`](./packages/sdk) | `@efs-project/sdk` | **TypeScript** — apps, scripts, agents reading/writing EFS off-chain. viem-native. |
| [`packages/solidity`](./packages/solidity) | `@efs-project/solidity` | **Solidity** — a compile-in library so your *own contract* can read/write EFS. |

```bash
npm i @efs-project/sdk viem      # TypeScript SDK
npm i @efs-project/solidity      # Solidity library (compile-in)
```

## Repo layout

```
packages/
  sdk/         TypeScript SDK   (tsup, viem, vitest)
  solidity/    Solidity library (Foundry, ships .sol source)
examples/      runnable consumers (foundry / hardhat / ts)
docs/adr/      architecture decision records (this repo's decisions)
```

The cross-cutting design lives in the **planning vault**; this repo holds the code and its per-repo ADRs. See [AGENTS.md](./AGENTS.md) for the boundary rule.

## Develop

```bash
pnpm install
pnpm build       # turbo: builds both packages
pnpm test        # turbo: vitest + forge test
pnpm typecheck
pnpm lint        # biome
```

Requires **pnpm 9+**, **Node 20+**, and **Foundry** (for the Solidity package).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Every change to a published package needs a Changeset.

## License

[MIT](./LICENSE)
