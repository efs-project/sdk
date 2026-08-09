---
"@efs/sdk": patch
---

Three write-time validation fixes on values that become authoritative.

Arweave transaction ids must now be canonical base64url. 43 base64url characters carry 258 bits but the id is a 32-byte hash, so the final character's low two bits are padding and must be zero — the length-and-alphabet screen accepted a non-canonical spelling that strict base64url and Arweave parsers reject, and `fs.write` could confirm it as a file's only mirror.

`contentType` no longer accepts media RANGES. Both halves used the HTTP token grammar, which permits the wildcard character, so `text/` + wildcard passed — that is what a client sends in `Accept`, not what a file is, and stored as authoritative metadata it even reads as displayable text because `fs.overview()` keys on the `text/` prefix. Type and subtype now use the RFC 6838 restricted-name grammar; parameter names and values keep the token grammar.

The reserved `size` property is now validated on the shared builder alongside `contentType` and `contentHash`. A malformed value does not degrade gracefully as it first appears: every reader's `parseSize` returns `undefined`, and in `reads/overview.ts` that `undefined` skips the documented pre-fetch `too-large` short-circuit entirely, so the overview attempts a fetch and fails at the render cap instead of returning `{kind: 'too-large'}` without touching the network. `fs.info()` simply omits the size. The canonical non-negative decimal form that file writes emit is required.
