---
"@efs/sdk": patch
---

Two fixes: (1) `efs.props.list` bounds its key-ANCHOR enumeration. Key anchors are attester-independent and non-revocable, so any account can permanently append PROPERTY-bucket anchors under someone else's DATA — trusting the raw count let a third party make this public read consume unbounded memory and RPC (an EAS read plus a value read per row). The scan is now capped at `MAX_PROPERTY_SCAN` (1024 raw rows), with a per-call `maxKeys` option to bound it further; the index is append-ordered, so a DATA's genuine earlier-minted keys are the ones retained. (2) List reads keep the FULL ranked lens-candidate set instead of pre-filtering it with a `length` probe — a candidate that was empty at probe time but gains an entry before the follow-up read is now reachable (it had been dropped for the whole request, and permanently for a memoizing `entries()` handle). Every verb already checks liveness as it walks, so removing the probe also removes one read per candidate.
