---
"@efs/sdk": patch
---

The declared `attester` must be the account that actually signs. `submitEdgePlan`, `submitEdgePlanWithUID`, and `Tier1Submitter.submit` now reject a mismatch before broadcasting — previously a direct caller of these exported seams could pass an unrelated address, and the confirmed receipt would stamp it into `roles.author`/`signer`/`payer` (and, on the submitter seam, `DataRef.resolvedBy`), attributing on-chain attestations to an address that never authored them and making later reads through that ref resolve under the wrong lens. Rejected rather than silently corrected: a divergent attester means the caller's model of who is writing is wrong. Relayer/paymaster role divergence still rides `roles`, which is unaffected.
