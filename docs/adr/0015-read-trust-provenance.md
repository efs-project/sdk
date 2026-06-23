# ADR-0015: Read-trust provenance on read results

**Status:** Proposed
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
   come from, and is existence/revocation current?" (provenance).

   ```ts
   type TrustDescriptor = {
     source: 'live' | 'indexer' | 'cache' | (string & Record<never, never>)
     existence: 'confirmed' | 'unconfirmed'        // on-chain existence checked against `source`?
     revocation: 'live' | 'as-of' | 'unchecked'    // revocation currency of the winning record
     asOf?: bigint                                 // snapshot time (epoch seconds) when revocation:'as-of'
   }
   ```

   Content authenticity stays **verify-or-throw** at the boundary (unchanged); `trust` only
   reports the genuinely-uncertain part (existence + revocation freshness).

2. **The bare-value sugar stays fail-closed on trust**, exactly as it already is on
   `verification`. `readText`/`readBytes`/`readJson` throw on a trust problem, gated by a new
   `require` option on `ReadOpts`:
   - `'confirmed'` (default) — the source must confirm existence + current-or-snapshot
     revocation; a content-only cache that cannot speak to revocation throws `StaleTrust`.
     A live read and a fresh-indexer read both pass (so the sugar does **not** start throwing
     the day a non-live source ships).
   - `'live'` — additionally reject any non-chain-head answer (no `as-of`).
   - `'any'` — disable the gate (the trust analogue of `verify:false`).

3. **Land now, populated trivially.** Every read today is live, so verbs stamp
   `{ source:'live', existence:'confirmed', revocation:'live' }`. The surface is locked in
   before offline/indexer sources land, so populating it richly later is purely additive.

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

## Alternatives considered

- **Opt-in `readWithTrust()` (lean `read()` default).** Disqualified on the security axis:
  the 90% `readText()` would silently return revoked-but-cached content, recreating the EAS
  footgun, and the field would be invisible to agents.
- **Fold `trust` into `verification`.** Collapses two orthogonal axes (authentic bytes vs
  live placement) into one union and re-creates the exact "green bytes ≠ live file" confusion
  the split exists to prevent. Rejected — keep them separate.
- **Default the sugar to `require:'live'`.** Would make working hobbyist code throw the day an
  indexer/cache source ships. Rejected for `'confirmed'` (the honest floor of what's
  verifiable), with `'live'` available opt-in.
