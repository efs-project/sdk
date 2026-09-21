---
"@efs/sdk": patch
---

`efs.raw.verifyDeployment()` now probes through a chain-guarded client pinned to the resolved
deployment. It resolved the deployment from the live chain but then ran its `getCode` +
schema-UID `readContract` checks via the unguarded `publicClient`; a mutable provider that
switched chains between resolution and the probes would verify the resolved chain's addresses
against the new chain (or falsely pass on a fork with matching addresses). The probe now fails
closed with `WrongChain` on drift — the same guard already used by `readContext` and the
standalone namespace reads.
