---
"@efs/sdk": patch
---

Three review fixes: every second-leg failure after the SSTORE2 chunk LANDS (abort, chain drift, wallet rejection before/at the manager deploy) now throws the new `OnchainStoreIncomplete` carrying the landed `chunkAddress`/`chunkTx` — the chunk is irreversible and paid for, so recovery can wrap the existing chunk instead of a blind retry paying for a duplicate (post-landed aborts/drifts previously escaped raw, matching neither the layered submitter's model nor the duplicate-spend hazard); attestation hydration now honors its documented revoked-degrades-to-`undefined` contract (EAS returns full records for revoked UIDs, so a direct `eas.attestationsFor` input or a revoke racing an expansion surfaced revoked records as live); and the artifact envelope's version floor is enforced — `0`/negative/fractional versions are `MalformedArtifact` (structural corruption), while newer-than-supported stays `UnsupportedArtifact`.
