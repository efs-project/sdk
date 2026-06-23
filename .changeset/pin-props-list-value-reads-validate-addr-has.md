---
"@efs/sdk": patch
---

Two fixes:

- **`props.list` pins ALL its reads to one resolved chain.** The prior guard only covered the
  anchor-page read; the per-anchor `getAttestation` still used the unguarded `publicClient`, and
  the value reads went through `readContext()`, which RE-RESOLVES `liveDeployment()` (a second,
  possibly-different deployment). A provider that switched chains mid-list would then decode
  chain-A anchor UIDs against chain B (wrong/empty values). All reads now route through the
  guarded client pinned to the single resolved deployment; the value reads use that pinned
  context instead of a re-resolving `readContext()`.
- **`lists.has` validates ADDR-mode target width.** `Address | Hex` is not runtime-distinguished,
  so a 32-byte UID whose trailing 20 bytes matched a listed address was silently truncated+padded
  into a colliding membership key — a false `true` for the wrong target kind. `has` now rejects a
  non-20-byte address target (`InvalidArgument`), mirroring the write-side `validateAddTarget`.
