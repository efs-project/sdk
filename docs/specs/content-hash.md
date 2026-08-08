# Spec — content hashing

> How EFS records and verifies a file's content hash. Normative source: **contracts
> [specs/10-file-metadata-encoding.md](https://github.com/efs-project/contracts/blob/main/specs/10-file-metadata-encoding.md)**
> (Accepted, ratified 2026-06-20). SDK decision: [ADR-0016](../adr/0016-content-hash-multibase-multihash.md)
> (supersedes ADR-0006's bare-digest convention).

## The value

A file's hash is recorded as a reserved-key PROPERTY on the file's DATA attestation:

- **key:** `contentHash`
- **value:** a **multibase-prefixed multihash** string. The canonical written form is
  `f1220<64 lowercase hex>` — `f` = base16, `12` = sha2-256, `20` = 32-byte digest,
  then the sha2-256 digest of the raw file bytes (69 chars total). The digest is the
  **same digest a raw CIDv1 embeds**, so the file's `contentHash` and its IPFS CID
  carry one hash, not two.

Accepted on **read** (never emitted): the `f1b20…` keccak-256 alternate, and the
`b`/base32 (RFC 4648 lowercase, no padding) rendering of either. Those two multihash
codes (`0x12` sha2-256, `0x1b` keccak-256) are the **only** registered functions at
genesis — a closed registry; anything else is a permanent, unverifiable value and
reads as `malformed-claim`. A bare 64-hex digest (the superseded ADR-0006 form) is
algorithm-ambiguous and also reads as `malformed-claim`.

Companion reserved-key PROPERTYs on the same DATA:
- `size` — the byte length, as a decimal string (no leading zeros).
- `contentType` — the MIME type.
- `cid` — an IPFS CID string (locator/identity for IPFS retrieval; specs/10 §4).

## Writing

The SDK computes `contentHash` from the bytes on every write (`hashContent(bytes)` →
the canonical `f1220…` form). A user never types a hash. Because PROPERTY values are
non-revocable interned content (contracts ADR-0052), emitting exactly the canonical
form is load-bearing: two encodings of one digest are **distinct permanent interned
values** that never dedup against each other (specs/10 §2.2). The `ContentHash` brand +
trusted constructor keep a non-canonical string out of the persistence path.

## Verifying (trust-relative — read this carefully)

`contentHash` is a **lens-scoped** PROPERTY: anyone can attest their own onto a
popular DATA. So verification is **trust-relative, not absolute integrity**. The SDK
verifies fetched bytes against the `contentHash` attested by **the same attester whose
lens won placement** (`read`'s `resolvedBy`): it decodes the claim (`decodeContentHash`),
runs the function the multihash code names, and compares **at digest level** — a `b…`
base32 claim or a keccak alternate of matching content verifies. It reports:

- `matches-author` — bytes hash equals that author's claim.
- `mismatch` — bytes do not match (or exceed the declared `size`).
- `no-claim` — the resolving author attested no `contentHash`. **This is UNVERIFIABLE,
  not "ok"** — callers must treat it as failure-to-verify, not success. The type
  forbids mistaking it for a pass.
- `malformed-claim` — the claim doesn't decode (bare digest, `0x`-prefixed, uppercase,
  unregistered code, wrong length). An authoring bug, not tampering — and never a pass.

The SDK never emits a bare `'verified'` that an attacker's lens could satisfy.

### Fetch-path safety (implementation requirements)

- **Mirror selection:** `fetch` resolves mirrors only from attesters in the resolving
  lens stack — never lens-blind (an attacker can attest a MIRROR onto popular DATA).
- **Streaming under a size cap:** hash incrementally while fetching; abort the
  attempt once bytes exceed the SDK ceiling (caller `maxBytes`, 50 MB default) —
  never buffer an unbounded stream. The author-declared `size` is untrusted
  metadata, NOT a transport cap: it neither lowers nor raises the ceiling. It is
  enforced as a POST-fetch consistency check — a complete body larger than the
  claim reports `mismatch`. (Folding the claim into the cap would turn any
  under-declared `size` into an every-mirror transport failure instead of the
  documented `mismatch`; conversely a caller needing a tighter allocation bound
  must set `maxBytes` — the claim cannot provide it, so a `size: 1` claim still
  buffers up to the ceiling before reporting `mismatch`.)
- **No transport trust:** ignore the HTTP `Content-Type`; use the lens-resolved
  `contentType` PROPERTY only. A CID is a *locator*, never a verification input in
  the engine (a raw CIDv1 shares the canonical digest; dag-pb/chunked CIDs do not).

## Dedup / interning lookups

Value-keyed lookups (`valueHash` = keccak of the *string*) must key on the canonical
form: route any accepted-form input through `decodeContentHash(value).canonical`
before comparing or querying, or equal digests in different encodings will silently
miss each other.

## Migration (decades-out)

When sha2-256 weakens, a **specs/10 revision registers a new multihash code**; readers
add the new function and dispatch on the code as they already do. The self-describing
value carries the algorithm, so old and new entries never collide. (ADR-0006's
`contentHashV2` new-key plan is retired.)

## Trustless on-chain verification

For on-chain (SSTORE2) content, a contract/reader can recompute sha2-256 from the
stored bytes via the precompile at `0x02` (~2× keccak gas; fine off the hot path),
strip `f1220`, and compare the 64 hex chars as a `bytes32` — the base16 canonical form
is chosen upstream precisely so a Solidity verifier needs only a hex parser.
