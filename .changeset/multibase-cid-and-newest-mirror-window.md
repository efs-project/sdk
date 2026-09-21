---
"@efs/sdk": patch
---

Two mirror-readability fixes: (1) the write preflight now rejects unassigned multibase prefixes instead of accepting any alphanumeric string of plausible length — `ipfs://notavalidcid` no longer mints a MIRROR no gateway can parse. Assigned-but-undecoded multibases (base36 `k`, base32hex `v`, …) are screened against their own alphabet, so a resolvable CID is still never refused. (2) Mirror scans now window the NEWEST 500 raw slots rather than the oldest. The raw referencing array is append-only (revoking never frees a slot), so past 500 records the SDK was pinned to the oldest 500 and could not see any newly added mirror — while `EFSRouter._bestMirrorUri` caps at the same 500 walking in reverse and serves them fine. The SDK now selects the same set the router does.
