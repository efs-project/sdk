# ADR-0019: The EFS v1 profile boundary

**Status:** Accepted
**Date:** 2026-08-07
**Related:** ADR-0008 (factory + semver — extended, not replaced), ADR-0014/0015 (the read seams the boundary composes with), SDK PR #1 review 2026-08-07 (R1–R6), planning `Designs/efsv2/` (the v2 corpus this hedges against), planning R1 (the pre-v2 SDK corpus decision)

## Context

EFS v2 is a **carrier replacement**, not an upgrade: EAS is dropped (2026-07-07 ruling), EAS attestation UIDs become deterministic chain-free logical IDs, 9 schemas become 5 kinds, "attester" becomes "author". A v1 EAS UID and a v2 logical ID are both `bytes32` — **indistinguishable without a stamp** — so once real data persists v1 refs, an unversioned SDK would eventually reinterpret one as the other and silently mis-dereference. Meanwhile v2 has no ETA (the owner inbox holds P-1…P-23 + LP-1…LP-10 unanswered) and v1 consumers exist now. The v2 corpus itself validates the hedge: v2 basis-stamps every answer, separates venue locators from logical identity, and versions its domain constants. What survives v2 per its own transition plan — the `fs.*` verbs, typed errors, fetch/verify, receipts/progress, detection — is exactly the surface this ADR keeps profile-neutral.

## Decision

- **R1 — the factory name IS the profile.** `createEfsV1Client()` is canonical (`createEfsClient` a deprecated one-cycle alias); the client carries `readonly profile: 'efs/v1'` (`EFS_PROFILE_V1`); `EfsV1Client`/`EfsV1ReadClient`/`EfsV1ClientConfig` alias the existing types. v2 lands as a SIBLING factory + client type — v1 callers never break, and no dispatcher/generic machinery exists to mis-route. Rejected: a required `profile: efsV1(...)` param (per-call ceremony + heavy conditional-namespace typing) and an optional one (a silent default is the exact silently-reinterpret hazard); a nested `efs.v1.*` namespace (call-site churn for zero type-safety gain — the discriminant + distinct client types already prevent confusion).
- **Persisted-artifact stamps.** The durable set is deliberately MINIMAL: `DataRef` (designed to be carried alone), `WriteReceipt` (the documented durable resume/recovery artifact), `FileWriteGraph` (the future relay-handoff plan — stamp only, serializer later). Each carries `profile: 'efs/v1'`. Session DTOs (`ReadResult`/`EfsFile`/`FileInfo`, estimates, list pages) are NOT stamped — their durable payload is the embedded ref; over-stamping is ceremony with no consumer.
- **R3 — `toJSON` is logging, never persistence.** Durable storage goes through `artifacts.ts`: `serializeDataRef`/`parseDataRef`, `serializeWriteReceipt`/`parseWriteReceipt` over the envelope `{ efs: { artifact, profile, v }, data, ext? }` — lossless tagged bigints (`{"$efsbigint": "…"}`), fail-closed `UnsupportedArtifact` on a foreign profile or newer version, `MalformedArtifact` on shape failure, opaque extensions (`ext` + unknown `data` keys) preserved verbatim. `parseWriteReceipt` deliberately rejects `toJSON` output.
- **R4 — roles separated; the write-side `lens` is gone.** `WriteOptions.lens` → **`author`** (a lens is READER policy; `author` — not `attester` — because it is the vocabulary v2 keeps where EAS's "attester" dies; the receipt-internal `WriteRoles.author` matches). `WriteReceipt.roles: WriteRoles = { author, signer, payer, submitter? }` — all one EOA on Tier-1 (output-only; simple callers construct nothing), with `SubmitterContext.roles` as the seam AA/relay submitters use to record payer/submitter divergence. Roles live on receipts/submit-context, NOT the pure plan (`FileWriteGraph` is author-agnostic by construction — submission identity at plan altitude would be the wrong layer).
- **R5 — objective capabilities + result-carried basis** (landed with ADR-0014/0015's amendments): `authoritative: boolean` → `state: 'head' | 'lagging' | 'pinned'` + `pinnedBasis`, `ReadBasis` on results, `TrustDescriptor` gains `basis` — one three-layer provenance story, not two overlapping ones.
- **R2 — stable verbs, versioned result envelopes.** The v1-scoped surface is named by `EfsV1ProtocolSurface` (`eas`/`raw`/`decode`/`graph`/`props`/`mirrors`/`redirects`/`lists`/`account`) — EAS/deployment-specific by construction. `fs.*`, lenses-as-concept, pagination, safety limits, typed errors, and plan/receipt UX are the stable surface a future profile re-implements behind the same verbs; result SHAPES may still version (v2 conformance changes absence/grading semantics), which the named-and-exported option/return types absorb.
- **R6 — `@efs/solidity` versions the IMPORT PATH**, not the symbols: sources move to `src/v1/`, exports narrow to `./src/v1/*.sol`. The profile is explicit and greppable in every consumer import; contract code keeps clean names (`EFSLib`, no `V1` suffix noise). A native v2 library lands at `src/v2/` (or a sibling package if dependency sets diverge — not foreclosed).

## Consequences

- A persisted v1 ref is exactly what a committed v1→v2 wrapper mapping would consume — the planning-side ask that turns "real data accumulates on v1" into a bounded one-shot import (tracked in the vault, not here).
- Pre-publish, so every rename/required-field is free (ADR-0008); the deprecated `createEfsClient` alias keeps in-flight branches compiling one cycle.
- Deliberately NOT built: a working v2 adapter (every exact v2 byte is reopened — it would be built twice), `FileWriteGraph` serialization (lands with the relay slice), `BatchReceipt` roles (lands with `batch()`).

## Alternatives considered

- **No profile boundary (ship unversioned, break at v2)** — rejected: the bytes32 ambiguity makes the eventual break SILENT, not loud.
- **`attester` for the write-side rename** — rejected despite matching EAS wire vocabulary and the receipt's prior internal naming: "attester" dies with the carrier; `author` survives, and the R4 role struct uses it — one word, both eras.
- **Stamping every DTO** — rejected: ceremony without a consumer; the durable set is the boundary.
