# Specs

**Plain-language description of how the SDK works** — the authoritative reference for *current behaviour*. If you want to understand what the SDK does and how to think about it (as a human or an agent), start here.

This is one of three doc layers; keeping them distinct stops duplication and rot:

| Layer | Question it answers | Lives in |
|---|---|---|
| **Specs** (this folder) | *How does it work now?* — plain-language current behaviour | `docs/specs/` |
| **ADRs** (`docs/adr/`) | *Why did we choose X?* — decisions + alternatives | `docs/adr/` |
| **Design** (planning vault) | *What + why at the architecture level?* — cross-cutting, often historical once built | `planning/Designs/sdk-architecture.md` |
| **API reference** _(later)_ | *Exact signatures* — mechanical, generated | `docs/api/` (typedoc) |

Rules of thumb:

- A spec describes **behaviour that exists** (or is the agreed target for the slice being built). It is not a decision log and not a design doc — when it explains *why*, it links to an ADR.
- Specs are **Ephemeral-to-Durable**: revise them as behaviour changes. They track the code, not the history.
- One concept per file. Keep them scannable.

## Index

- [overview.md](./overview.md) — the SDK at a glance: the two packages and the core model.
- [standards.md](./standards.md) — the EIPs/ERCs/CAIPs the SDK is built on (ADOPT/SEAM/WATCH/AVOID), researched 2026-06-11.
- [future-proofing.md](./future-proofing.md) — engineering doctrine + roadmap risk (history expiry, gas/calldata, durability, indexing, security/clear-signing, key-sets), 9-domain pass.
- [content-hash.md](./content-hash.md) — the bare-SHA-256 `contentHash` convention.

_More specs land as the implementation does (reads, writes/batching, lenses/identity, errors)._
