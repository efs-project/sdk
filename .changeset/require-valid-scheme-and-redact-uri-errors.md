---
"@efs/sdk": patch
---

Mirror URIs must now start with a syntactically valid `scheme:` prefix, and URI validation errors no longer echo inline `data:` payloads.

A locator like `"https ://cdn.example/file"` carries no surrounding whitespace but parses as schemeless because of the space before the colon. With an explicit transport anchor supplied, the transport lookup returned before any scheme check, so it was minted as a "custom" transport and then rejected at read time by `resolveTransport` — an only-mirror that can never be read. The preflight now requires a scheme on every locator (`MissingTransport`, the same code and message shape the schemeless path already used; what changed is its reach). This is not a scheme allowlist — ADR-0056's custom-scheme escape hatch is untouched — but an explicit `transportDefinition` no longer substitutes for a scheme, because the reader parses the scheme off the URI itself. The preflight also now shares `uriScheme` with the reader instead of keeping its own copy of the pattern, which is how the two drifted apart.

Separately, the whitespace-rejection error interpolated the full URI, which for a `data:` mirror means inline file content — and that check runs before the length cap, so up to 8 KiB of payload could reach logs and telemetry. It now uses the same `summarizeUri` redaction the transport layer applies, on the trimmed string (leading whitespace defeats `summarizeUri`'s `data:` detection and would otherwise still leak the first 200 characters).
