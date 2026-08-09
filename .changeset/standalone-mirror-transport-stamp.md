---
"@efs/sdk": patch
---

`buildMirrorPlan` now stamps its transport definition and anchor schema, so the layered boundary runs the transport-anchor gate on standalone MIRROR plans too. Previously `efs.mirrors.add({ transport })` (which takes the caller's UID verbatim) and the exported builder + `submitEdgePlan` pair sent an arbitrary or stale definition straight to MirrorResolver, paying for a reverted transaction instead of failing before broadcast.
