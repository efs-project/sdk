---
"@efs/sdk": patch
---

Placement PIN provenance is now snapshot-consistent: the read path exposes `placementPinUID` (and thus `sourceUIDs.placement` / expanded placement attestations) only when the active PIN slot's `targetID` matches the winning DATA returned by the path resolution. A concurrent re-placement landing between the two sequential reads previously attached the NEW placement's PIN to the OLD DataRef, letting provenance contradict the data it rides with; on mismatch the PIN is now withheld exactly like a legitimately empty slot.
