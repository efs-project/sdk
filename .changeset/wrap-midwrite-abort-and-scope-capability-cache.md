---
"@efs/sdk": patch
---

Two fixes:

- **A mid-write abort preserves partial-write context.** `submitLayeredTier1`'s per-layer
  cancellation check ran before the layer's refs were available and let a raw `AbortError`
  escape — so cancelling between wallet confirmations after an earlier layer mined dropped the
  `landed` UID map. The check now runs after the refs are built and, once a prior layer has
  landed, folds the abort into `WriteNotSentError` (`PartialBatchFailure`, the `AbortError` as
  `cause`) for recovery; an abort before the first layer (nothing landed) still escapes raw.
- **`detectAccount`'s cache is scoped per connector.** The profile cache was process-global,
  keyed only by `address@chain`, but `getCapabilities` (→ `gasless`/batch) is
  connector-dependent. Profiling an account through a wallet without EIP-5792 and then through
  a different connector that supports it reused the stale profile. The cache is now scoped by
  the connector (the wallet client object), so a different connector never reuses another's
  capability profile (`efs.account.capabilities()` passes the wallet as the scope).
