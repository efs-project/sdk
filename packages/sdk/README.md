# @efs/sdk

TypeScript SDK for the **Ethereum File System (EFS)** — read and write an on-chain filesystem built on EAS attestations.

> **Status: pre-1.0.** The read/write core (fetch + verify + lens-scoped resolution, single-file write) is implemented; some surfaces (folder Overviews, preview, one-signature batch, directory filtering) still throw `NotImplemented`. See [`docs/specs/overview.md`](../../docs/specs/overview.md) for how it works and [`docs/adr/`](../../docs/adr) for decisions.

## Install

```bash
npm i @efs/sdk viem
```

`viem` is a peer dependency (ADR-0002) — the SDK is viem-native and pulls in no `ethers`.

## Quickstart

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

// Read a file in one line. `read*` verbs fetch + verify the bytes; the fail-closed
// sugar (`readText`/`readBytes`/`readJson`) throws on a contentHash mismatch.
const text = await efs.fs.readText('/docs/readme.md', { lens: identity('jamescarnley.eth') })

// No lens, no wallet? A read-only client falls back to the deployment's system lens,
// so a public file still reads in one line:
const readme = await createEfsClient({ provider, chain: sepolia }).fs.readText('/docs/readme.md')

// Need the bytes + the trust status (not just the value)? Use `read`:
const file = await efs.fs.read('/logo.png', { lens: identity('jamescarnley.eth') })
console.log(file.bytes, file.verification) // 'matches-author' | 'mismatch' | 'no-claim'

// The pointer only (which DATA/version + who resolved it, no bytes):
const ref = await efs.fs.locate('/logo.png', { lens: identity('jamescarnley.eth') })

// Metadata, presence, and listings:
const meta = await efs.fs.info('/docs/readme.md', { lens: identity('jamescarnley.eth') })
const there = await efs.fs.exists('/docs/readme.md', { lens: identity('jamescarnley.eth') })
for await (const entry of efs.fs.list('/docs', { lens: identity('jamescarnley.eth') })) {
  console.log(entry.kind, entry.name) // 'file' | 'dir'
}

// Write a file (Tier-1 multi-attestation under the hood; needs an `account`).
await efs.fs.write('/notes/hello.txt', new TextEncoder().encode('gm'))

// EFS results carry bigints (file `size`, tag weights, list `maxEntries`, …), and
// bare `JSON.stringify` THROWS on a bigint. Use `efs.toJSON` (or the exported
// `jsonReplacer`) to serialize a result — bigints render as decimal strings. Note:
// they come back as strings on `JSON.parse`, not bigints (a lossy round-trip).
const json = efs.toJSON(meta) // == JSON.stringify(meta, jsonReplacer)
```

> **Implemented:** `efs.fs.read`/`readText`/`readBytes`/`readJson`, `locate`, `info`, `exists`, `list`, `write`; `efs.lenses`, `efs.eas`, `efs.raw`, the off-chain fetch/mirror engine, content hashing, and the deployments registry.
>
> **Coming (throws `NotImplemented` with a workaround today):** `efs.fs.overview`/`setOverview` (folder READMEs — read/write `README.md` directly for now), `efs.fs.preview` (write cost estimate), `efs.batch` (one-signature multi-write — call `fs.write` per file for now), and `list({ excludes })` directory filtering (ADR-0011).

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
