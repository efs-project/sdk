---
"@efs/sdk": patch
---

Two review fixes: (1) `efs.lists.add`/`remove` now pin their list-config read to the already-selected deployment and its chain-guarded read client, like every other write planner — previously the read went through a live re-resolving read context, so a provider drifting after the one-time chain assert could serve a chain-B list mode into a chain-A plan (wrong-mode entry encoding, a false/skipped append-only rejection, or a submit that can only revert). (2) When a redirect's follow-up index tx BROADCASTS but its confirmation fails, the partial recovery receipt now counts that signed-and-sent transaction in `signatureCount` (a leg that never broadcast still adds nothing), so persisted recovery artifacts and confirmation-count UIs no longer underreport the write.
