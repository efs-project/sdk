# ADR-0016: `contentHash` is a multibase-multihash string (specs/10 conformance)

**Status:** Accepted
**Date:** 2026-08-07
**Related:** supersedes ADR-0006; contracts specs/10-file-metadata-encoding.md (Accepted, James ratified 2026-06-20), contracts ADR-0064, contracts ADR-0052 (PROPERTY non-revocable), SDK PR #1 review r3739110399

## Context

ADR-0006 chose a bare SHA-256 digest and bet on persuading upstream ("surfaced to the schema-freeze dev as an ADR-0049 follow-up"). Upstream instead ratified the opposite: contracts specs/10 + ADR-0064 (James, 2026-06-20) pin `contentHash` as a **multibase-prefixed multihash** — canonical form `f1220<64 lowercase hex>` (sha2-256), optional alternate `f1b20…` (keccak-256), with `b`/base32 accepted on read. Cross-repo specs are authoritative, and PROPERTY values are non-revocable (contracts ADR-0052): a divergent SDK writer mints permanent, non-deduping values in the interned value index (specs/10 §2.2 warning), so the SDK cannot hold a private encoding.

Two of ADR-0006's premises no longer hold: "the key is the algorithm tag" conflicts with the ratified single self-describing slot + closed code registry (specs/10 §5.1 — no algorithm-suffixed keys), and the "IPFS-interop is false" claim is answered by construction — sha2-256 canonical makes `contentHash` share the raw-CIDv1 digest (specs/10 §2.3/§4). This also removes a v1↔v2 conflict: the EFS v2 Codex freezes a "contentHash multibase-multihash convention", which v1 now writes too.

## Decision

- **Writers emit exactly `f1220<64 lowercase hex>`** (sha2-256, 69 chars) — `hashContent` is the trusted constructor and the `ContentHash` brand now means this canonical string.
- **Readers accept `f`/base16 and `b`/base32** (RFC 4648 lowercase, no padding) for the two registered codes (`0x12` sha2-256, `0x1b` keccak-256), dispatch on the multihash code, and **compare at digest level** (`decodeContentHash` + `verifyContent`).
- **Unregistered codes and bare digests report `malformed-claim`** — the registry is closed at genesis (specs/10 §2.1) and a bare digest is algorithm-ambiguous (specs/10 §1). No bare-digest tolerance on read: the SDK never shipped, so no SDK-written durable data exists; the only legacy Sepolia population is debug-UI `0x`-keccak values, which the old code already reported `malformed-claim` (behavior preserved). The healing path for any pre-spec file is a re-attested canonical PROPERTY + re-PIN (retraction at the binding, ADR-0052).
- **No multiformats dependency** — the base32 decoder is hand-rolled (~20 lines); the size gate and the viem-only rule (ADR-0002) both argue against a dep.
- **One decode/verify implementation** — the mirror engine's `statusFor` delegates to `verifyContent`; the format rule lives only in the codec module.
- Conformance vectors are imported from specs/10 §7 as the test suite.

## Consequences

- Byte-for-byte conformance with any future Solidity verifier and with the contracts spec's vectors.
- Dedup/interning lookups must key on `decodeContentHash(value).canonical` — two encodings of one digest are distinct interned on-chain values (specs/10 §2.2); the codec doc labels this trap.
- Migration for future algorithms is a specs/10 revision (new registered codes), not a new key — ADR-0006's `contentHashV2` plan is retired.
- Until the contracts repo's specs/10 §8 migration lands, the debug UI keeps minting non-conforming `0x`-keccak values that this SDK correctly reports `malformed-claim` — named in the PR rather than silently diverged from.

## Alternatives considered

- **Keep bare SHA-256, lobby upstream again** — rejected: the ratification explicitly considered and closed this (specs/10 §5.1 resolution note); a second divergence would fragment the permanent value index.
- **Accept bare digests on read (lenient)** — rejected: the algorithm is unknowable (specs/10 §1); guessing sha2 would mislabel keccak legacy values as `mismatch`, strictly worse than `malformed-claim`.
- **`multiformats` dependency** — rejected: one ~20-line decoder vs a dependency tree on the size-gated bundle.
