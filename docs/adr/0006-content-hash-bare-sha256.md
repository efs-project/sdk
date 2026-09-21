# ADR-0006: `contentHash` is a bare SHA-256 digest

**Status:** Superseded by [ADR-0016](./0016-content-hash-multibase-multihash.md)
**Date:** 2026-06-10
**Related:** docs/specs/content-hash.md, contracts ADR-0049 (DATA empty / hash-as-data), planning/Designs/sdk-architecture.md

## Context

A file's `contentHash` is recorded as a string PROPERTY and used by readers to verify fetched bytes. This is effectively permanent (a long-lived protocol artifact), and the encoding was left unwritten upstream (ADR-0049 gestured at "self-describing multihash / CID" but never specified it). We evaluated the options with two expert passes + web-researched governance/longevity facts.

The candidates: raw **keccak-256** (EVM-native, cheapest on-chain), raw **SHA-256** (web/file standard, NIST FIPS 180-4, every stdlib), and **multihash/CID** (self-describing, Protocol Labs).

Findings that decided it:
- **The "future-proofing" of self-description is largely illusory.** When SHA-256 eventually weakens, every reader must ship code to compute the *new* algorithm regardless — multihash tells you the name, not the implementation. So multihash ≈ a versioned field in migration cost; it's *labeling*, not future-proofing.
- **The IPFS-interop rationale is false.** An IPFS CID is the hash of the chunked Merkle-DAG root, **not** `sha256(file bytes)`, so a content hash does not need to be a CID; readers verify *fetched bytes* against the recorded hash regardless of transport.
- **Governance favors SHA-256** — a formal NIST/FIPS standard with no single owner; multihash's registry is single-vendor-governed (Protocol Labs, one maintainer, IETF draft not adopted).
- **EFS already namespaces by PROPERTY key**, so the key name *is* the algorithm tag — `contentHash` means SHA-256, removing the only real benefit of an in-value tag (disambiguating two 32-byte algorithms).

## Decision

**`contentHash` = a bare SHA-256 digest, lowercase hex, 64 chars, no `0x` prefix** — byte-identical to `sha256sum`. One algorithm; no multihash, no CID, no in-value tag. The PROPERTY key `contentHash` denotes SHA-256 permanently.

- The SDK computes it automatically from the file bytes on write (`hashContent`); users never type a hash.
- keccak-256 is **not** used for the content hash (it matches no web/IPFS tool and would force an EVM hash lib on every consumer). It remains EAS/EVM-internal only; if cheap on-chain trustless derivation is ever wanted, that is a *separate, explicitly-named* field, not this one.
- **Migration** (decades out, when SHA-256 weakens): introduce a new explicitly-named PROPERTY key (e.g. `contentHashV2`); readers add the new algorithm then. Same reader-update cost as multihash, with no parser and no ambiguity.

## Consequences

- **Zero install for consumers** — verify with `sha256sum`, `crypto.subtle.digest('SHA-256')`, or any stdlib; no multiformats dependency.
- On-chain trustless verification still possible (SHA-256 precompile `0x02`, ~2× keccak gas — negligible off the hot path).
- The contract stores the value opaquely (`string`), so this imposes no on-chain constraint — it is purely a client convention.
- Cross-repo: surfaced to the schema-freeze dev as an **ADR-0049 follow-up** to simplify the upstream "multihash/CID" gesture to bare SHA-256, so EFS stays consistent rather than the SDK diverging.

## Alternatives considered

- **Multihash-wrapped SHA-256** — rejected: its self-description is a labeling convenience, not future-proofing; adds a parser + a single-vendor standard dependency for ~2 bytes the PROPERTY-key already provides.
- **Raw keccak-256** — rejected: no web/IPFS interop, forces an EVM hash lib on consumers; cheapest on-chain but the content hash isn't an EVM primitive.
- **Full CID** — rejected: heaviest (multibase + codec + multihash); a CID is a Merkle-DAG root, not a file-bytes hash.
