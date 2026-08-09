---
"@efs/sdk": patch
"@efs/solidity": patch
---

Three closures: (1) `buildRedirectPlan` stamps symlink plans with `symlinkTargetUID`, and the layered boundary re-runs the direct-DATA readability proof — the exported builder + `submitEdgePlan` pair could previously author the unreadable symlink the namespace verb refuses. (2) Solidity `setRedirect` applies the same gate: a `symlink` whose target attests as DATA requires the author's own active mirror (`NoActiveMirror`) before the atomic attest+index; ANCHOR targets are unaffected. (3) The exported `resolveTransport` now applies `DEFAULT_MAX_BYTES` when `maxBytes` is omitted — a direct caller's untrusted `data:` URI could previously materialize an arbitrarily large payload since `resolveData`'s cap checks were all conditional; only `fetchVerified` callers got the 50 MB default.
