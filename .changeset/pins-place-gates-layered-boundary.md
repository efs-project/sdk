---
"@efs/sdk": patch
---

The placement-gate family closes on the TypeScript side: (1) `efs.graph.pins.place` now reads the target attestation through the chain-guarded client and refuses both foreign-authored DATA (a placement whose mirrors/properties are invisible under the placer's lens — `ForeignDataUID` parity) and self-authored non-DATA targets (the PIN would index under the target's actual schema while `pins.active()` and file resolution read the DATA slot — `NotDataUID` parity) before anything broadcasts. (2) The hardlink authorship/schema gates moved from `submitWriteTier1` into `submitLayeredTier1` — the common boundary every exported executor funnels through — so combining the exported builder with `submitLayeredTier1` or the edge submitter can no longer bypass them (edge plans are `hardlink: false`, so this is a no-op for them).
