# ADR-0013: Re-vendor the ERC-5219 `EFSBytesStore`; keep the direct chunk reader

**Status:** Accepted
**Date:** 2026-06-21
**Related:** PR #1, contracts ERC-5219 `EFSBytesStore` (efs-project/contracts main), planning/Designs/web3-bytesstore-sdk-followup.md, planning/Designs/web3-standards-compliance.md, ADR-0010

## Context

The on-chain (zero-infra) write path deploys a chunk-manager contract per file and
publishes a `web3://<store>` MIRROR. The vendored creation bytecode
(`writes/onchain-bytecode.ts`) was still the old `MockChunkedFile` compile (1-arg
constructor, no standard interface). The contracts repo merged a **productionized
ERC-5219 `EFSBytesStore`** (`EFSBytesStore(address[] chunks, string contentType_)` +
`resolveMode()`/`request()`), so a bare `web3://<store>` now resolves in any
EIP-4804/6860/5219 client — but only for stores deployed from the new bytecode with the
2-arg constructor.

Two decisions followed: (1) re-vendor + thread the new constructor arg; (2) whether the
SDK's on-chain *reader* (`mirror/web3.ts`) should switch from the direct
`chunkCount`/`chunkAddress` + `getCode` path to the new standard `request()` interface.

## Decision

**Re-vendor** `EFS_BYTES_STORE_BYTECODE` from the merged contracts artifact, widen the
deploy ABI/`OnchainWalletClient` to the 2-arg constructor, and thread the file's MIME
(the same value bound as the lens-scoped `contentType` PROPERTY; empty ⇒
`application/octet-stream`) into the store deploy. Every SDK-written on-chain file is now
a standards-compliant `web3://<store>`.

**Keep the direct chunk reader** (`mirror/web3.ts` unchanged). Do **not** switch the
read path to `request()`.

## Consequences

- SDK-deployed stores self-describe and resolve in generic web3:// clients, not just via
  the EFS router/SDK. No public TypeScript API change (internal write plumbing only) —
  not a semver break; the changeset is a `patch`.
- The reader stays byte-for-byte aligned with `EFSRouter.sol`'s extcodecopy chunk path
  (the binding parity invariant): the router kept its extcodecopy path, so reading via
  `request()` would create a second, divergent read path for the same bytes.
- `request()` is now EIP-7617 per-chunk paginated, so it buys no fewer round-trips than
  the direct reader — switching would be more code for no gain, and would import the
  store's untrusted `Content-Type` (the SDK trusts the lens-scoped PROPERTY instead).
- **Vendoring caveat:** the planning hand-off pinned an earlier pre-hardening compile
  (`a7093cc6…`, 4159 bytes). The actually-merged contract is `79b76a2c…` (4726 bytes),
  validated by the contracts' 20 `EFSBytesStore` deploy tests. Always re-derive the
  bytecode + sha from the artifact of the exact merged commit.
- **Follow-up (deferred):** a real fork round-trip (SDK writes a multi-chunk on-chain
  file, reads it back, `contentHash` verifies) is still the authoritative end-to-end
  check; the unit tests mock the deploy. Tracked with the existing fork-test gap.

## Alternatives considered

- **Switch the reader to ERC-5219 `request()`** — rejected: breaks router parity, more
  code for paginated reads, and imports an untrusted content-type to discard. If the SDK
  later needs to read *external* ERC-5219 resources or the router's `web3://<router>/<path>`
  form, add a **separate** `request()`-based reader behind the `transport.ts` seam keyed
  on URI shape — never as a silent fallback for the bare-store path.
