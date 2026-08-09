# ADR-0015: Read-trust provenance on read results

**Status:** Accepted (implemented 2026-08-07 — `trust` is a required field on `EfsFile`/`FileInfo`/`ReadResult`, `requireTrust`/`StaleTrust`/`assertTrust` live; amended before acceptance with the `basis` evidence layer, see the 2026-08-07 note)
**Date:** 2026-06-23
**Related:** PR #1, ADR-0006 (contentHash bare SHA-256), ADR-0008 (public API & semver), ADR-0014 (pluggable read source), planning/Designs/sdk-read-surface.md

## Context

Once reads can come from a live chain, an offline snapshot, or an indexer (ADR-0014), a
read result needs to say **where its answer came from and how much to trust its freshness**.
This is security-load-bearing, not a performance hint:

EAS UIDs are content-derived and attestations are signed, so **offline the SDK can still
cryptographically verify a file's CONTENT** (the bytes match the attester's claimed hash —
the existing `verification` field). But it **cannot** verify, offline, that the attestation
still **exists** on chain or has not been **revoked**. So a cached read can show
`verification: 'matches-author'` (authentic bytes) while the file is actually revoked. A
revoked file or permission served from cache, looking fully "verified," is a footgun.

The substrate itself models the anti-pattern: the EAS SDK returns raw data with revocation
as a field you must remember to check, and signature verification as a separate opt-in call.
That "the trust signal exists but is easy to forget" shape is exactly what content-addressed
systems (IPFS/Helia, Sigstore/cosign) deliberately moved away from — they make verification
mandatory or unmissable. The dominant convention for *freshness* hints (Firestore
`metadata.fromCache`, TanStack `isStale`) is always-present-but-segregated metadata; for
*security verdicts* it is verify-or-throw or an always-on flag (Stripe `livemode`). EFS sits
at the intersection — data that is **verifiable AND possibly-stale on different axes at
once** — so the safe design is inline + always-present + axis-split, with content kept
verify-or-throw.

The decision (Fork 1 on PR #1): does this trust metadata ride **inline on every rich read
result**, or is it **opt-in** via a separate method? Adding a required field to a published
return type later is a semver-major (ADR-0008), so the shape must land now even though every
source today is live.

## Decision

Adopt the **hybrid** — extend the pattern the SDK already uses for content `verification`:

1. **Inline, always-present `trust` on the rich read results.** `EfsFile`, `FileInfo`, and
   `ReadResult` carry a required `trust: TrustDescriptor`, a sibling sub-object (never folded
   into `verification`, never mixed into the data). It is **orthogonal** to `verification`:
   `verification` = "are the bytes authentic?" (content); `trust` = "where did this answer
   come from, and how fresh is it?" (provenance/freshness).

   Modeled as a **discriminated union on `freshness`** (per the naming review), so the single
   security-load-bearing axis has one name per state — the dangerous case is spelled `stale`
   and cannot hide behind a reassuring sibling field, `asOf` exists only where it is
   meaningful, and incoherent combinations are unrepresentable. `source` reuses the
   `ReadSourceCapabilities.kind` vocabulary verbatim (one term per backend, SDK-wide):

   ```ts
   type TrustDescriptor =
     | { freshness: 'current'; source: 'live' | (string & Record<never, never>); basis?: ReadBasis }
     | { freshness: 'as-of'; source: 'snapshot' | 'indexer' | (string & Record<never, never>); asOf: number; basis: ReadBasis }
     | { freshness: 'stale'; source: 'snapshot' | (string & Record<never, never>); basis?: ReadBasis }
   //  current = chain-head (existence + revocation current now)   — safe
   //  as-of   = checked against a snapshot/indexer head at `asOf`  — bounded-stale
   //  stale   = content-only cache: existence + revocation UNKNOWN — the footgun, named
   ```

   **Amendment (2026-08-07, pre-acceptance — the `basis` evidence layer.)** The
   provenance story is THREE layers, one coherent chain: source **capability**
   (static — `ReadSourceCapabilities.state: 'head' | 'lagging' | 'pinned'`,
   replacing the subjective `authoritative: boolean`) → observed **basis**
   (per-answer evidence — `ReadBasis`: chainId, block number/hash, finality,
   asOf) → this derived **verdict** (`freshness`). Derivation: `'head'` →
   `current`; `'lagging'`/`'pinned'` with a usable basis → `as-of` (the `asOf`
   copied from it); `'pinned'` without one → `stale`. The honesty rule: a
   `'head'` source claims only that it follows ITS BACKEND's head — the RPC
   endpoint is the stated residual trust, and no boolean ever asserts
   canonical-chain authority the SDK cannot prove.

   Content authenticity stays **verify-or-throw** at the boundary (unchanged); `trust` only
   reports the genuinely-uncertain part (freshness of existence + revocation).

2. **The bare-value sugar stays fail-closed on trust**, exactly as it already is on
   `verification`. `readText`/`readBytes`/`readJson` throw on a trust problem, gated by a new
   `requireTrust` option on `ReadOpts` — a minimum-freshness floor on the same lattice as the
   descriptor (the key is `requireTrust`, not `require`, to avoid the CommonJS `require()`
   collision):
   - `'as-of'` (default) — accept `current` or `as-of`; reject `stale` (throws `StaleTrust`).
     A live read and a fresh snapshot/indexer read both pass, so the sugar does **not** start
     throwing the day a non-live source ships.
   - `'current'` — additionally reject any non-chain-head answer (no `as-of`).
   - `'any'` — disable the gate (the trust analogue of `verify:false`).

3. **Land now, populated trivially.** Every read today is live, so verbs stamp
   `{ freshness:'current', source:'live' }`. The surface is locked in before offline/indexer
   sources land, so populating it richly later is purely additive.

Add one error code `StaleTrust` (beside `ContentHashMismatch`/`MalformedClaim`) and one
`assertTrust(result, path, require)` helper beside the existing `assertVerified` — the sugar
calls both. `trust` is non-projectable (always present), matching `sourceUIDs`.

## Consequences

- **Pit-of-success for a security signal.** The safe path is the default (the one-liner
  sugar fails closed), and the unsafe state is always visible on the rich result. Opt-in
  trust (a separate `readWithTrust()`) was rejected: opt-in security signals get forgotten,
  and the cached-revocation case is precisely where silence hurts.
- **Agent-legible.** AI consumers pattern-match on fields present in the returned object;
  inline `trust` is inspectable on every rich read, where an opt-in method would be invisible
  to an agent that called `read()`.
- **One mental model, not two.** `trust` works like `verification` already does
  (inline-on-rich, fail-closed-on-sugar), so devs learn one rule. The 90% case
  (`file.text()` / `readText()`) returns a bare value and never sees `trust` — no common-case
  bloat; it appears only on the already-rich `read`/`info`/`locate` results, nested under one
  `.trust` key.
- **Semver.** Adding required `trust` to `EfsFile`/`FileInfo`/`ReadResult` is a breaking shape
  change — taken now, pre-1.0, while it is cheap (ADR-0008). After this, offline/indexer
  provenance is additive *inside* `.trust`, never a new breaking field.
- **Residual limit (honest).** Inline makes `trust` *inspectable* and the sugar gate makes it
  *enforceable*, but neither forces a dev who reads the rich object and opts down to actually
  check it — true of every inline-metadata system. We surface honestly; we cannot compel.
- **Follow-up: `FileInfo.verified`.** Its current `VerificationStatus | 'revoked' | 'unchecked'`
  union mixes the trust axis (`'revoked'`/`'unchecked'`) into the content-verification field —
  the same fold this ADR rejects. In the behavioral slice, `FileInfo` should carry the `trust`
  sibling and `verified` should narrow to pure `VerificationStatus`, consistent with `EfsFile`.

## Naming review (2026-06-23)

Two independent expert reviews of the field names converged. Adopted: the discriminated-union
`freshness` model (was a flat `existence`/`revocation` record — which let the footgun state read
as `existence:'confirmed'` and made two grid cells incoherent); `source` literals reconciled
with `ReadSourceCapabilities.kind` (was `'cache'`, now `'snapshot'`); the `'live'` value
collision removed (a `source` *and* a `revocation` value previously); one freshness vocabulary
replacing the `unconfirmed`/`unchecked`/`as-of` synonym spread; and `require → requireTrust` over
the same lattice (default `'as-of'`, the honest floor). The field key stays `trust` (agent-legible,
the Fork-1 decision) with a doc note that authenticity lives in `verification`; `provenance` was
the runner-up name.

## Alternatives considered

- **Opt-in `readWithTrust()` (lean `read()` default).** Disqualified on the security axis:
  the 90% `readText()` would silently return revoked-but-cached content, recreating the EAS
  footgun, and the field would be invisible to agents.
- **Fold `trust` into `verification`.** Collapses two orthogonal axes (authentic bytes vs
  live placement) into one union and re-creates the exact "green bytes ≠ live file" confusion
  the split exists to prevent. Rejected — keep them separate.
- **Default the sugar to `requireTrust:'current'`.** Would make working hobbyist code throw the
  day an indexer/snapshot source ships. Rejected for `'as-of'` (the honest floor — accept
  bounded-stale, reject only the unknown-revocation `stale` cache), with `'current'` opt-in.
- **Flat `{ existence, revocation }` record** (the pre-review shape). Let the footgun state read
  as a reassuring `existence:'confirmed'`, allowed incoherent combinations, and overloaded the
  `'live'` literal across two fields. Rejected for the `freshness` discriminated union.
