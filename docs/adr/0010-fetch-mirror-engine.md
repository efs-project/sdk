# ADR-0010: Off-chain fetch/verify/mirror engine

**Status:** Accepted
**Date:** 2026-06-11
**Related:** ADR-0006 (bare-SHA-256 contentHash), ADR-0007 (error model); `docs/specs/future-proofing.md` §2 (mirror doctrine), `docs/specs/standards.md` (transports)

## Context

A file read is two halves: resolve an attestation to a `(contentHash, mirror URIs, contentType)` tuple, then fetch the bytes from a mirror and verify them. The **first half is blocked on the schema freeze**; the **second half is not** — it only needs `(uri, expectedHash) → verified bytes` and the already-decided `contentHash` convention (ADR-0006) and transport set (`standards.md`). Building it now means the freeze unblocks only the thin attestation glue, against an engine that already exists and is tested.

The mirror layer is also where the SDK touches **attacker-controlled bytes** (any mirror can be hostile, rate-limited, or dead), so its security posture is load-bearing, not incidental (`future-proofing.md` §2/§4).

## Decision

Ship a standalone `src/mirror/` engine, exported from the package root, with **zero new runtime dependencies** (global `fetch`, Web Crypto via the existing `hashContent`, standard JS only):

1. **`resolveTransport(uri)` + `TRANSPORT` allowlist** — parses a URI to `{ scheme: TransportName; httpUrls(gateways) }`. `ipfs://`, `ar://`, `https://`, and `data:` (RFC 2397) are fully implemented; `web3://` parses but its resolution throws `TransportNotImplementedError` (it needs a chain call + ERC-6944 decode — a deliberate seam for later). CIDs are treated as **locators only** — never as the integrity check (ADR-0006: CID ≠ `sha256(bytes)`).
2. **`fetchVerified(mirrors, expectedHash, opts?)`** — ordered sequential failover across mirrors/gateways with a per-attempt timeout (default 10s) and a **hard size cap** (default 50 MB; trips on both an honest `Content-Length` and a lying one, mid-stream). It hashes the full bytes and returns `{ bytes, verification, contentType?, mirrorUsed }` where `verification ∈ {matches-author, mismatch, malformed-claim, no-claim}` (mirrors `verifyContent`). **Bytes are always returned, even on mismatch** — the caller decides; the SDK never silently swallows a failed verification.
3. **Security invariants** (the reason this is its own module):
   - **Verify before trust** — the independent SHA-256 is the whole model.
   - **nosniff** — the response `Content-Type` is informational only; it never drives handling, and bytes are never executed.
   - **SSRF guard** (`checkSsrf`) — blocks loopback/private/link-local/CGNAT/cloud-metadata IPs (v4 + v6, incl. IPv4-mapped) and `localhost`/`*.local`/metadata hostnames, with explicit `allowPrivateHosts`/allowlist escapes. Documented gap: with global `fetch` there is no pre-connect DNS resolution, so DNS-rebinding isn't fully closable here, and in-browser the SSRF concern is the browser's; the guard is the node-side defense.
4. **Injection seams** — gateway lists, timeout, size cap, `AbortSignal`, and a `fetchImpl` override are all options, so the engine is testable without network and overridable per call.

`efs.fs.fetch` will be the thin wrapper that, once reads resolve a `DataRef` to its `contentHash` + mirror URIs, calls `fetchVerified`.

## Consequences

- The verify-half of reads exists and is unit-tested (28 tests, `fetch` mocked) before the freeze; post-freeze work shrinks to attestation resolution.
- Zero new dependencies keeps the supply-chain surface minimal (`future-proofing.md` §4) and the bundle small (engine fits inside the 8 kB budget).
- `web3://` resolution and DNS-rebinding-proof SSRF are known, documented gaps deferred to when the chain-read path lands.
- The default IPFS gateway list (`ipfs.io`, `dweb.link`, `cloudflare-ipfs.com`) will rot as public gateways are deprecated — it is overridable by design, and durability remains the app's job (pair a fast mirror with a permanent one).

## Alternatives

- **`@helia/verified-fetch`** — verifies against the *CID*, which we deliberately don't trust as the integrity root (ADR-0006); it's a fine optional path for CID-native callers but wrong as our core. Rejected as a dependency.
- **Defer the whole engine until the freeze** — leaves a large, freeze-independent, security-sensitive chunk unbuilt and untested while we wait. Rejected; building it now is the highest-leverage use of the blocked period.
- **Wait for `web3://` libraries** — none exist; the mirror layer owns web3:// (standards.md). Parsed-now/resolved-later is the pragmatic split.
