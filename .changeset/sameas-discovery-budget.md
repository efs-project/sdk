---
"@efs/sdk": patch
---

`redirects.canonical()`'s `MAX_SAMEAS_NODES` budget is now enforced when targets are DISCOVERED, not just before fetching the next node. Previously each of the 256 fetched nodes could queue up to 512 targets, all of which the leaf-backfill step then inserted into the Tarjan graph — so a crafted `sameAs` graph could push roughly 131,000 nodes through the SCC pass despite the documented 256-node cap. Edges whose target cannot be admitted are dropped and reported through the existing `complete: false`, keeping the explored graph within the budget.
