---
"@efs/sdk": patch
---

Two fixes: (1) when a bound cursor's attester turns out empty, list pagination now restarts the ranked scan from the TOP instead of only advancing past that attester — a higher-ranked candidate that gained entries while the cursor was held must win, and previously a bound cursor on the last-ranked candidate reported end-of-list. (2) `edgeSubmitContext` now supplies the chain-guarded public client, so the submitter's boundary gates (hardlink authorship/schema, reused anchor, symlink readability, transport anchors) can no longer approve a plan against state read from a drifted chain — matching what the file-write planner already did.
