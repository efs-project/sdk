# Spec — content hashing

> How EFS records and verifies a file's content hash. Decision + rationale: [ADR-0006](../adr/0006-content-hash-bare-sha256.md).

## The value

A file's hash is recorded as a reserved-key PROPERTY on the file's DATA attestation:

- **key:** `contentHash`
- **value:** the **SHA-256** of the raw file bytes, as a **lowercase hex string, 64 chars, no `0x` prefix** — byte-identical to `sha256sum <file>`.

The PROPERTY *key* is the algorithm tag. `contentHash` means SHA-256, always. There is no in-value algorithm prefix, no multihash, no CID.

Companion reserved-key PROPERTYs on the same DATA:
- `size` — the byte length, as a decimal string.
- `contentType` — the MIME type.

## Writing

The SDK computes `contentHash` from the bytes on every write (`hashContent(bytes)`). A user never types a hash. (Registering already-existing off-chain content by a hash someone else computed is the only manual case.)

## Verifying (trust-relative — read this carefully)

`contentHash` is a **lens-scoped** PROPERTY: anyone can attest their own onto a popular DATA. So verification is **trust-relative, not absolute integrity**. The SDK verifies fetched bytes against the `contentHash` attested by **the same attester whose lens won placement** (`read`'s `resolvedBy`), and reports:

- `matches-author` — bytes hash equals that author's claim.
- `mismatch` — bytes do not match (or exceed the declared `size`).
- `no-claim` — the resolving author attested no `contentHash`. **This is UNVERIFIABLE, not "ok"** — callers must treat it as failure-to-verify, not success. The type forbids mistaking it for a pass.

The SDK never emits a bare `'verified'` that an attacker's lens could satisfy.

### Fetch-path safety (implementation requirements)

- **Mirror selection:** `fetch` resolves mirrors only from attesters in the resolving lens stack — never lens-blind (an attacker can attest a MIRROR onto popular DATA).
- **Streaming under a size cap:** hash incrementally while fetching; abort and report `mismatch` if bytes exceed the smaller of the declared `size` and a hard SDK ceiling — never buffer an unbounded/declared-50GB stream.
- **No transport trust:** ignore the HTTP `Content-Type`; use the lens-resolved `contentType` PROPERTY only.

## Migration (decades-out)

When SHA-256 weakens, introduce a new explicitly-named key (e.g. `contentHashV2`) for the successor algorithm; readers add it then and prefer it. The key name carries the algorithm, so old and new entries never collide and no value parsing is needed.

## Trustless on-chain verification

For on-chain (SSTORE2) content, a contract/reader can recompute SHA-256 from the stored bytes via the precompile at `0x02` (~2× keccak gas; fine off the hot path) and compare to `contentHash` — making the hash verifiable, not merely a claim.
