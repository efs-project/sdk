---
"@efs/solidity": patch
---

The Solidity `contentType` check now accepts optional whitespace around media-type parameters, and rejects a dangling `;`.

Diffing the Solidity validator against the TypeScript one clause by clause — rather than comparing them in spirit — surfaced three further divergences beyond the per-name length cap. Two of them **rejected valid values**, which is the worse direction: `text/plain ; charset=utf-8` and its HTAB variant are legal (RFC 9110 permits OWS around the `;`) and the TypeScript rule accepts them, but the Solidity path reverted the write. Optional whitespace is now trimmed off the name portion before the restricted-name check, and HTAB is permitted inside the parameter section — CR, LF, NUL and every other control character stay blocked, which is the property that matters for a value served as a `Content-Type` header. Separately, `text/plain;` with no parameter after the semicolon is now rejected, matching the TypeScript grammar.

The two validators still differ on parameter *content* (`text/plain; ~~~garbage~~~` is accepted on-chain, rejected in TypeScript) — that remains the deliberate bounded-subset trade-off, since full RFC 9110 parameter parsing would cost the caller gas on every write.
