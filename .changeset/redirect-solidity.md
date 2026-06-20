---
"@efs/solidity": patch
---

feat(solidity): REDIRECT (alias) read resolution + write wrapper (ADR-0050)

`EFSReader` gains `redirectTarget` (lens-scoped authoritative active-redirect
read), `resolveWithRedirects` (follow a caller-supplied redirect chain to its
terminal target with cycle detection and a bounded max-hop cap — never an
unbounded loop), and `followKind`. `EFSLib`/`EFSWriter` gain `setRedirect`
(cardinality-N edge; `refUID` = source, `data = (target, kind)`, revocable),
plus the `redirect` field on `SchemaUIDs` and the frozen `REDIRECT_KIND_*`
constants. On-chain resolvers do not store or follow redirects (the reverse
fan-in is off-chain by design), so a pure on-chain reader is fed candidate
redirect UIDs and authoritatively decodes/guards/follows them. Cycle handling
fail-closes (reverts) rather than computing ADR-0050's lowest-UID-in-SCC
canonical node, which needs the full graph.
