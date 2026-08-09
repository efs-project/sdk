---
"@efs/sdk": patch
---

Mirror URIs with leading or trailing whitespace are now rejected at the write preflight. The known-scheme parse is anchored, so `" https://cdn.example/file"` matched no scheme, fell out of the known-scheme branch entirely, and was minted as a "custom" transport — bypassing the structural checks its scheme should have received. At read time `resolveTransport` then rejected the unchanged string for having no scheme, leaving an only-mirror that can never be read. Rejected rather than trimmed: the chain stores the URI verbatim, so silently rewriting it would mint a locator the caller never wrote.
