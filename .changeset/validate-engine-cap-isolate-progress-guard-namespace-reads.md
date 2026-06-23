---
"@efs/sdk": patch
---

Three independent hardening fixes:

- **`fetchVerified` validates `maxBytes`.** The mirror engine is public surface, so a direct
  caller could pass `NaN`/`Infinity` (the cap checks are `>` comparisons — `NaN` never rejects
  an oversized payload, `Infinity` disables the 50 MB ceiling). It now rejects a
  non-finite/non-positive cap up front, matching the `fetchRef` wrapper.
- **A throwing progress hook can no longer corrupt a write.** `submitLayeredTier1` wraps the
  per-layer `onLayer`/`onProgress` callback: an exception from best-effort reporting code, after
  an early layer mined, is swallowed instead of propagating and aborting the remaining
  irreversible dependent layers (which would manufacture a partial write with no structured
  error). Cancellation remains via the explicit `AbortSignal`.
- **Standalone-namespace reads guard the resolve-then-read TOCTOU.** `graph.tags.active/list`,
  `graph.pins.active`, `props.list`, and `mirrors.list` resolved `liveDeployment()` then read
  via an unguarded client; a provider that switched chains in between used the resolved chain's
  addresses on the new chain. They now route reads through a `chainGuardedPublicClient` pinned
  to the resolved deployment chain (fail closed with `WrongChain`), matching `readContext`.
