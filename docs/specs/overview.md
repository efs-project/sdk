# Overview — the EFS SDK at a glance

> **Status: target behaviour (scaffold).** The shapes here are agreed; the code is being filled in. Where a statement describes a decision, it links to an ADR. Full design rationale: `planning/Designs/sdk-architecture.md`.

EFS (Ethereum File System) is an on-chain filesystem built on [EAS](https://attest.org) attestations: **paths** (folders/anchors) → **data** (file content) → **mirrors** (where to fetch the bytes). All content is keyed by the **attester address** that wrote it. The SDK is how developers read and write that filesystem.

## Two packages

- **`@efs/sdk`** (TypeScript) — for apps, scripts, and agents reading/writing EFS *off-chain*. viem-native ([ADR-0002](../adr/0002-viem-only-no-eas-sdk-dependency.md)).
- **`@efs/solidity`** (Solidity) — a *compile-in library* so your own contract can read/write EFS, staying the attester ([ADR-0003](../adr/0003-onchain-sdk-as-compile-in-source.md)).

Both speak the same model below; they differ only in environment (one runs in a wallet/RPC context, the other inside your contract, gas-bounded).

## The core model (four ideas)

**1. A lens is a *resolved set of attesters*, not an address.** "Whose version of `/logo` do I see?" is answered by a lens — an ordered list of attester addresses, first-one-wins. The SDK builds that list from a configurable hierarchy (you → who you're viewing → who you trust → system defaults); a raw address is just the simplest lens. The type is opaque so richer resolution (ENS → a person's device keys) can drop in later without breaking callers.

**2. Two kinds of reference, and they don't interchange.**
- A **DataRef** points at *these exact bytes / this version* (a permanent id). Use it when the link must not move — e.g. a mirror serving specific content.
- A **PathRef** points at *whatever is active here now* (`/logo` → the newest). Use it for navigation.
Picking a path where you meant a specific version is silent breakage when the data later changes — so the SDK keeps them as distinct types.

**3. Writing a file is several attestations; the SDK batches them.** A single logical write (content + placement + metadata) is multiple on-chain attestations. The SDK groups them so the user signs **~2–3 times instead of ~8**, with no protocol change. (Why not 1: the pieces reference each other by ids only known after mining — see `planning/Designs/sdk-minimal-clicks.md`.)

**4. Your contract stays the author.** On-chain, the SDK is a library that *inlines into your contract*, so EFS records *your contract* as the attester — never a shared helper. This is load-bearing for lenses ([ADR-0003](../adr/0003-onchain-sdk-as-compile-in-source.md)).

## What the SDK does and doesn't do

- **Does:** simplify multi-step reads/writes, resolve lenses, batch writes, expose EAS cleanly (viem-native), and give a typed escape hatch to the raw contracts.
- **Doesn't (yet):** bundle an indexer. Reverse-lookups ("who tagged this?") that need an external index are stubbed and out of scope for v1.

For exact signatures, see the package READMEs and (later) the generated API reference.
