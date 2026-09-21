---
"@efs/sdk": patch
---

Concrete `existingAncestorTagUIDs` are now validated before anything broadcasts: the builder shape-checks them (nonzero bytes32, both content kinds) and stamps them on the plan, and the submission boundary verifies each is an ANCHOR attestation. Their visibility TAGs sit in the LAST layer, so a well-shaped but nonexistent or non-anchor UID previously reverted only after the DATA, file anchor, metadata and placement had mined — a paid, half-applied write.
