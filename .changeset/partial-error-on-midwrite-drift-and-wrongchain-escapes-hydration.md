---
"@efs/sdk": patch
---

Two chain-guard error-model refinements:

- **A mid-write chain switch yields the partial-write error, not a bare `WrongChain`.** When a
  multi-layer write has already mined an earlier layer and the pre-send chain guard then fails,
  `submitLayeredTier1` now folds it into the no-tx `WriteNotSentError` (`PartialBatchFailure`) —
  carrying the landed-UID map for recovery, with the `WrongChain` as `cause` — instead of letting
  the guard escape raw and stripping the partial-write context. A drift on the FIRST/only layer
  (nothing landed) still escapes as raw `WrongChain` (no partial write to describe).
- **A systemic `WrongChain` escapes attestation hydration.** `attestationsForUIDs` (backing
  `expand:['attestations']` and `efs.eas.attestationsFor`) mapped every per-UID rejection to
  `undefined`. A systemic `WrongChain` (the guarded client failing closed after a post-resolution
  drift) was thereby swallowed into empty/missing attestations that looked like genuine absence.
  It now re-throws a `WrongChain` rejection; only true per-UID absence/revocation/transient
  failures degrade to `undefined`.
