---
"@efs/sdk": patch
---

The file-ANCHOR now mints in the SAME `multiAttest` layer as DATA (it depends only on the already-resolved parent — concrete, or the last `mkdir -p` folder from an earlier layer). Two `fs.write` calls racing for the same empty path both probe no-anchor; previously the loser's DATA layer mined before its anchor layer reverted `DuplicateFileName`, leaving paid storage plus an orphaned DATA graph with no file written. With the anchor in DATA's layer the slot collision rolls the whole layer back atomically — the loser lands nothing on the EAS side, its storage deploys ride the partial error's `storage` for reuse, and the retry resolves the winner's anchor into the overwrite path. (The Solidity `writeFile` is single-transaction and was already atomic.)
