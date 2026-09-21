---
"@efs/solidity": patch
---

The Solidity `contentType` check now caps each of `type` and `subtype` at 127 characters, matching RFC 6838 §4.2 and the TypeScript validator's `restricted-name` grammar. The previous check bounded only the total length at 255 bytes, so a value like 128 `a` characters followed by `/x` was persisted by the Solidity write path while every other public write door in the SDK rejects it as a non-IANA media type. The two validators are hand-mirrored across languages and cannot share code, so they need comparing clause by clause rather than in spirit.
