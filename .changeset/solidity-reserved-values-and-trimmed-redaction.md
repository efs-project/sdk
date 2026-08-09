---
"@efs/sdk": patch
"@efs/solidity": patch
---

The Solidity write path now enforces the reserved-key value contract, and URI redaction survives leading whitespace.

`EFSLib` is a separate public write path from the TypeScript SDK, and it stored reserved property values verbatim — so `{key: "contentHash", value: "0xdeadbeef"}` produced a fully successful write whose file then failed every default TypeScript read with `malformed-claim`, mirror bytes intact. `writeFile`'s reserved-key loop, `setProperty` and `setPropertyAt` now all validate through one `_assertReservedValue`, reverting with `InvalidReservedValue`. `contentHash` and `size` are checked against their exact canonical forms; `contentType` gets a deliberately bounded structural check (shape, RFC 6838 restricted-name characters so media ranges are rejected, a 255-byte ceiling, and printable-ASCII-only parameters so CR/LF cannot reach a served header) rather than the full RFC 9110 grammar, because on-chain string parsing costs the caller gas on every write. Non-reserved keys stay unconstrained.

Separately, `summarizeUri` now normalizes leading and trailing whitespace before deciding what to redact. Both its `data:` and userinfo tests are anchored, so a single leading space caused a `" data:…"` locator to print 200 characters of its inline payload, and a whitespace-prefixed credential URL to print its password. This matters on the read side in particular: `fetchVerified` can be called directly, and the chain is append-only, so legacy or foreign mirrors carry whatever they were minted with.
