---
"@efs/sdk": patch
---

Two boundary-validation fixes: (1) `resolveDeployment` now canonicalizes every schema UID on the returned record to `0x` + 64 lowercase hex (memoized copy; the source record is never mutated) and rejects values it cannot consume with a typed error — verification was already value-tolerant of how a custom record writes a UID (uppercase, leading-zero-shortened), but the non-canonical form then broke strict-equality consumers (the symlink walk reported valid redirect targets as dangling) and `bytes32` ABI encoding. (2) `resolveLens` validates every address at the common lens boundary with `isAddress` — a malformed template-compatible literal (`'0x1234'`) or a custom lens's bad output now fails immediately with a typed error instead of surfacing later as a generic ABI/RPC read failure.
