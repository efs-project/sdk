---
"@efs/sdk": patch
---

Mirror-URI validation errors no longer reintroduce the raw URI when wrapping a parser failure.

`UnsupportedUriError` redacts what it prints, but the write preflight caught it and rebuilt a higher-level message from the original string — so a credential-bearing URL leaked its password one layer up, and a malformed `data:` URI leaked its inline payload, into any log or telemetry recording the error. Four wrapper sites shared this shape (the IPFS-CID, `web3:`, generic known-scheme, and `efs.mirrors.add` scheme-prefix errors); all now route the URI through `summarizeUri`.
