---
"@efs/sdk": patch
---

HTTP(S) mirror URLs carrying embedded credentials are now rejected at parse, and any credentials that do appear are redacted from error and attempt output.

`new URL()` accepts `https://user:pass@host/…`, so such a URL passed the write preflight — but WHATWG `fetch` refuses to construct a Request from a URL with credentials and throws before any network call, so the mirror would confirm on-chain and then fail every read with `AllMirrorsFailedError`.

The redaction is a separate concern and applies regardless: `summarizeUri` is what every error and attempt record flows through, and it previously copied the userinfo component verbatim — including into the new refusal's own message. The chain is append-only, so a credential-bearing mirror minted before this guard still reaches readers, and its secret should not land in logs. Redaction targets only the userinfo component; an `@` in a path or query string is left alone.
