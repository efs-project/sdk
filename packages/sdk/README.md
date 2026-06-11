# @efs/sdk

TypeScript SDK for the **Ethereum File System (EFS)** — read and write an on-chain filesystem built on EAS attestations.

> **Status: scaffold.** The public surface is shaped; method bodies are stubs until the build lands. See [`docs/specs/overview.md`](../../docs/specs/overview.md) for how it works and [`docs/adr/`](../../docs/adr) for decisions.

## Install

```bash
npm i @efs/sdk viem
```

`viem` is a peer dependency (ADR-0002) — the SDK is viem-native and pulls in no `ethers`.

## Quickstart (target API)

The client is resource-namespaced (`efs.fs.*` for files, `efs.lenses.*`, `efs.eas.*`, `efs.raw.*`). Its boundary is the **standard** — an [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) provider + chain — so any wallet works; viem is the engine inside ([standards](../../docs/specs/standards.md)).

```ts
import { createEfsClient, identity } from '@efs/sdk'
import { sepolia } from 'viem/chains'

// Standard form — pass any EIP-1193 provider (window.ethereum, WalletConnect, …):
const efs = createEfsClient({
  provider: window.ethereum, // any EIP-1193 provider
  chain: sepolia,
  account, // the signing address; omit for a read-only client
})
// (viem-native callers can pass `{ publicClient, walletClient }` instead.)

// Resolve "the file at /logo" through an identity (ENS → key-set → lens).
// `read` returns a reference + who resolved it; `fetch` gets the bytes (verified).
const result = await efs.fs.read('/logo', { lens: identity('jamescarnley.eth') })
if (result) {
  const file = await efs.fs.fetch(result.data)
  console.log(file.bytes, file.verification) // 'matches-author' | 'mismatch' | 'no-claim'
}

// Write a file (batched multi-attestation under the hood).
await efs.fs.write('/notes/hello.txt', new TextEncoder().encode('gm'))
```

> **Status:** `efs.lenses`, `efs.eas`, content hashing, and the deployments registry are implemented; the `efs.fs.*` verbs above are the target shape and currently throw `NotImplemented`.

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
