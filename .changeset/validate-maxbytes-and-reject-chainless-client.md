---
"@efs/sdk": patch
---

Two read/construction hardening fixes:

- **Validate `maxBytes` before it becomes the fetch cap.** `fs.read`/`readText`/`readBytes`
  forwarded a caller `maxBytes` straight to the engine, whose cap checks are all `>`
  comparisons. A non-finite cap slipped the safety ceiling: `NaN` never trips a `>` (an
  over-cap body reads as in-bounds) and `Infinity` disabled the 50 MB default outright,
  letting an untrusted mirror buffer unbounded. A non-finite or non-positive `maxBytes` now
  fails closed with `InvalidArgument` before any read.
- **Reject a chainless `ViemConfig` public client at construction.** A viem client built
  from a bare transport (no bound `chain`) can answer `getChainId()` but exposes no
  synchronous construction chain. The write/raw/eas paths resolve the deployment sync from
  `publicClient.chain.id` and validate it against the live chain (the deliberate "writes
  validate, reads re-resolve" split), so a chainless client had no stable anchor — reads
  worked while writes/`efs.eas.*`/`efs.raw.*` threw a confusing `DeploymentNotFound` on
  first use. `createEfsClient` now fails fast with an actionable `InvalidArgument` telling
  the caller to bind a chain (or use the `{ provider, chain }` form).
