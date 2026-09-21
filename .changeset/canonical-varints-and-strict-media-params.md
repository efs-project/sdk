---
"@efs/sdk": patch
---

Two strictness fixes on values that reach the chain irreversibly.

CID varints must now be minimally encoded. `unsigned-varint` requires the shortest form, but the decoder returned the numeric value without checking, so `81 00` and `01` both read as version 1 — meaning a valid CID with a redundant byte spliced in cleared the entire write preflight and could be minted as a file's only mirror, while strict CID parsers and gateways reject the locator outright.

`contentType` parameters are now validated against the real RFC 9110 grammar. The quoted-value branch was `"[^"]*"`, which accepts raw control characters, and the separator used `\s*`, which admits CR and LF. A value like `text/plain; note="a<CR><LF>b"` therefore passed and was persisted as the authoritative PROPERTY and as the ERC-5219 store's reported MIME — a CRLF that any gateway echoing the header would emit verbatim. The quoted branch now spells out `qdtext` and `quoted-pair`, and whitespace is restricted to HTTP `OWS` (SP/HTAB). Legitimate quoted parameters, including escaped quotes, are unaffected.
