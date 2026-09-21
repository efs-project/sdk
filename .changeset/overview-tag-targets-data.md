---
"@efs/sdk": patch
---

The Overview `system` marker now targets the file's DATA instead of its file-ANCHOR. `EFSFileView.getDirectoryPageFiltered`'s per-item exclusion predicate classifies items by anchor type and, for FILES, resolves each placement's DATA UIDs and tests exclude TAGs on those (the anchor branch is folders-only, per the ADR-0054 asymmetry) — so the anchor-targeted marker never actually hid the Overview from `fs.list(container, { excludes: ['system'] })`, contradicting `setOverview`'s promise. The normal path tags the fresh DATA symbolically; the hardlink branch tags the concrete pre-existing DATA. Layer ordering is unchanged (the TAG still mines strictly before the placement PIN).
