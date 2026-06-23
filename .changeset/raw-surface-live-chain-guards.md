---
"@efs/sdk": patch
---

Extend the live-chain safety to the `efs.raw.*` escape hatch:

- **Raw writes are guarded regardless of a bound account.** viem raw writes accept a
  per-call `account`, so an unbound wallet on a different chain could call
  `efs.raw.*.write.*(args, { account })` and broadcast to the wrong chain — the previous
  guard skipped the chain check when no account was bound. The raw-write proxy now runs the
  chain assertion unconditionally (the bound-account early-return remains only on the
  higher-level write verbs, which derive the attester from the bound account).
- **Raw reads are guarded against a drifted provider.** The raw contract instances are
  bound to the construction-time deployment addresses; a mutable provider that switches
  networks would read those addresses on the new chain. The public client handed to the raw
  instances now validates the live chain matches the deployment before each `readContract`,
  failing closed with `WrongChain` rather than returning wrong-chain data.
