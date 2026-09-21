---
"@efs/sdk": patch
---

Partial-write honesty fixes in the layered submitter: (1) a layer that MINES successfully but whose `Attested` logs cannot be extracted now throws the new `WriteUidsUnknownError` (layer, mintedRefs, landed, txHash, and the same `storage` attachment seam) instead of `WriteRevertedError{mined:true}` — that class's contract says the refs did NOT mint, while in this state every ref exists on-chain, so recovery code branching on the top-level fields could resend and duplicate the whole layer. (2) `WriteNotSentError`'s message and docs no longer bless a whole-write retry unconditionally: `fs.write` does not resume, so the message now scopes the no-in-flight-tx claim to the unsent layer and, when earlier layers landed (or storage completed), directs recovery through `landed`/`storage` instead of a retry that would re-mint attestations, re-pay deploys, or revert on permanent duplicate anchors.
