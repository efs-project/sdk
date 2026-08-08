---
"@efs/solidity": patch
"@efs/sdk": patch
---

`@efs/solidity`'s redirect follower now matches the ratified resolution spec (specs/09 / ADR-0067), keeping the two published SDKs identity-consistent: `EFSReader.followKind` follows ONLY `symlink` (2) — `sameAs`/`supersededBy` are non-followed terminals (canonicalization and version history are separate, deliberate operations; an exact DATA identity never silently advances) — and `resolveWithRedirects`' `maxHops == 0` default is the ratified `D_MAX = 16` (was 8), hard ceiling 32. `@efs/sdk`: the redirect-lifecycle receipt wait (`set`'s index leg, `remove`'s revoke sequencing) re-asserts the LIVE provider chain immediately before waiting, so a post-broadcast chain switch fails closed (`WrongChain`) instead of polling another chain — where a landed index could read as a false `IndexingIncomplete` or a landed revoke could abort before its required `indexRevocation` leg.
