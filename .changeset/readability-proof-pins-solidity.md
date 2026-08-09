---
"@efs/sdk": patch
"@efs/solidity": patch
---

The readability proof extends to the last two placement surfaces: (1) `efs.graph.pins.place` now requires at least one ACTIVE mirror authored by the connected account on the target DATA before submitting (its plan is `hardlink: false`, so the layered submitter's hardlink proof didn't cover it) — a bare or all-revoked-mirror DATA refuses with guidance instead of confirming a placement whose every `read()` fails `AllMirrorsFailedError`. (2) Solidity `placeExisting` and `place` take the indexer (the thin `IEFSIndexerWrite` interface gains the two referencing-read getters) and revert the new `NoActiveMirror(dataUID, author)` unless the placer has an active MIRROR on the target — ownership proves who minted the DATA, not that the hardlink shortcut has metadata to reuse. Both scans walk raw-count-bounded filtered windows with first-hit exit (one count read plus one window in the healthy case).
