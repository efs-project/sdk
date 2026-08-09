---
"@efs/sdk": patch
---

Two more paid-partial-write gaps closed.

The Overview visibility TAG's `/tags/system` definition is now stamped onto the plan and verified to be an ANCHOR before layer 1 broadcasts. That TAG sits at `m + 3`, so a well-shaped but nonexistent definition was rejected by the resolver only after the DATA, file anchor, mirrors and metadata had mined — a paid, half-applied write. `writes/overview.ts` resolves the definition from the path and refuses ZERO, but `buildFileWriteGraph` is exported, so a direct caller could supply anything. This mirrors the existing gate on ancestor tag targets.

`efs.props.set(dataUID, 'contentHash', …)` is now validated against the canonical `ContentHash` form. The shared builder checked only `contentType`, so a malformed hash could become the active authoritative claim — and that is worse than a bad `contentType`: `readText`, `readBytes` and `readJson` report `malformed-claim` and throw even when the mirror bytes are perfectly intact, so a single property write could make a healthy file unreadable by default. File writes already persist only canonical hashes; this routes `props.set` through the same boundary.
