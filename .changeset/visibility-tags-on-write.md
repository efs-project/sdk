---
"@efs/sdk": patch
---

Fix a write-path correctness bug: a freshly written file did not appear in the
author's own lens directory listing, because the ancestor-walk **folder-visibility
TAGs** (overview.md "Upload flow" step 7; ADR-0038, ADR-0041) were never emitted.

A folder only shows in an attester's lens listing when that attester has an active
`TAG(definition = DATA_SCHEMA_UID, refUID = folderAnchor, weight = 1)` under it. The
write path now emits one such TAG for every generic ancestor folder from the file's
immediate parent up to **root exclusive** that the uploader hasn't already tagged:

- **Newly-created** folders (the `createParents` / `mkdir -p` chain) always get a
  TAG (brand-new folders).
- **Existing** ancestors are walked **bottom-up** via
  `EdgeResolver.getActiveTagWeight`, short-circuiting at the first already-tagged
  ancestor (steady-state zero cost). Existence checks are fanned with `Promise.all`.

The TAGs are threaded into the write DAG in a layer **after** every folder ANCHOR and
PIN, so a `createParents`-minted folder exists on-chain before its TAG references it
(via the existing symbolic-ref + per-layer submit mechanism). Root is never tagged
and the file's own leaf anchor carries no TAG. Hardlink placements into a new subtree
also tag their ancestor folders.
