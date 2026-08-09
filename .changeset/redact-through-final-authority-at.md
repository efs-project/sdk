---
"@efs/sdk": patch
---

Credential redaction now follows WHATWG's delimiter rule and strips through the FINAL `@` of the authority.

A raw `@` is legal inside a password, and WHATWG URL parsing treats the last `@` before `/`, `?` or `#` as the userinfo delimiter — so `https://alice:p@ss@example.com/file` parses with password `p@ss`. The previous redaction stopped at the first `@` and emitted `https://<credentials redacted>@ss@example.com/file`, leaking part of the credential into preflight errors, read errors for previously minted mirrors, and anything downstream that records them. An `@` appearing in a path, query or fragment is still left untouched.
