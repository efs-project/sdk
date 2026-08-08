---
"@efs/sdk": patch
---

Two boundary-gate corrections: (1) the unconditional DATA-bucket check at the layered boundary is now ACTUALLY in place — the previous changeset claimed it, but the edit script had crashed before writing and the `pins.place` inline gate masked the gap in tests; the review caught it. Every reused/definition anchor's `(name, forSchema)` payload is decoded and checked against the plan's expected bucket regardless of slot stamps, with the expected bucket now generalized via `existingAnchorForSchema` (files: DATA; property bindings: PROPERTY). (2) `buildPropertyPlan`'s reuse branch stamps the requested `(dataUID, key, PROPERTY)` slot, so the exported-builder path through `submitEdgePlan` verifies a reused key-anchor actually names that slot before layer 1 broadcasts — an unrelated anchor previously bound the fresh PROPERTY at a definition `props.get(dataUID, key)` never resolves.
