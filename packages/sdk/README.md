# @efs-project/sdk

TypeScript SDK for the **Ethereum File System (EFS)** — read and write an on-chain filesystem built on EAS attestations.

> **Status: scaffold.** The public surface is shaped; method bodies are stubs until the build lands. See [`planning/Designs/sdk-architecture.md`](https://github.com/efs-project/planning) for the design and [`docs/adr/`](../../docs/adr) for decisions.

## Install

```bash
npm i @efs-project/sdk viem
```

`viem` is a peer dependency (ADR-0002) — the SDK is viem-native and pulls in no `ethers`.

## Quickstart (target API)

```ts
import { createEfsClient, identity } from '@efs-project/sdk'
import { createPublicClient, createWalletClient, http } from 'viem'

const efs = createEfsClient({
  publicClient: createPublicClient({ transport: http() }),
  walletClient, // required for writes
})

// Read "the file at /logo", resolved through an identity (ENS → key-set → lens).
const file = await efs.read('/logo', { as: identity('jamescarnley.eth') })

// Write a file (batched multi-attestation under the hood).
await efs.pinFile('/notes/hello.txt', new TextEncoder().encode('gm'))
```

## Design notes that shape this API

- **Lenses are a resolved set, not an address.** `identity()` may expand (ENS → device key-set); `lens()` is a literal escape hatch. The type is opaque so adding expansion later doesn't break callers.
- **Static vs dynamic refs are distinct types.** `DataRef` = these exact bytes; `PathRef` = whatever's active here now. They never silently interconvert.
- **viem-only.** EAS access is exposed viem-native, not via the ethers-based EAS SDK.

## Develop

```bash
pnpm build      # tsup → dual ESM/CJS + .d.ts
pnpm test       # vitest (+ anvil fork for on-chain tests)
pnpm typecheck
```
