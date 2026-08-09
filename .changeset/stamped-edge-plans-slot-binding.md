---
"@efs/sdk": patch
---

Two placement-gate completions: (1) `buildPlacementPinPlan` now stamps its plan as a hardlink placement (`hardlinkDataUID` + the schema/anchor stamps), so the exported builder+executor pair (`submitEdgePlan`/`submitLayeredTier1`) runs the full gate set — authorship, DATA schema, active-mirror readability, ANCHOR definition — at the layered boundary instead of bypassing everything `pins.place` checks; the edge submit context carries the indexer address for the mirror proof. (2) The concrete-anchor gate now binds the reused anchor to the REQUESTED slot: `buildFileWriteGraph` stamps the requested parent + canonical name, and the submitter verifies the reused ANCHOR's `refUID`, decoded name, and DATA bucket name exactly that slot — a valid ANCHOR from a different slot previously skipped the mint and silently overwrote a different path. The standalone placement plan carries no slot stamps (its anchor is caller-chosen by design).
