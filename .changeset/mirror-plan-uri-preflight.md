---
"@efs/sdk": patch
---

`buildMirrorPlan` now runs the shared `validateMirrorUri` preflight — the one mirror path that was missing it. MirrorResolver accepts any nonempty bounded string, so a direct caller of the exported builder could mint a MIRROR carrying a locator the SDK itself refuses to resolve (`ipfs://!`, `web3://0x1234`), leaving the DATA unreadable when it was the only mirror. Custom/unknown schemes still pass through untouched (the ADR-0056 escape hatch).
