---
"@efs/sdk": patch
---

Extend the wrong-chain write guard to the standalone write verbs. The previous fix
covered `fs.write`/`fs.setOverview`, but `graph.tags.add`, `graph.pins.place`, `props.set`,
`mirrors.add`, `redirects.set`, and `lists.create`/`add` share a separate edge submit
context that did not assert the wallet was on the deployment chain — so a `ViemConfig`
with a wallet bound/connected to a different chain than the public client could still send
those EAS transactions to the deployment's addresses on the wrong chain. The shared edge
submit context now runs the same fail-closed `WrongChain` assertion (before any tx) via a
pre-flight thunk awaited in `submitEdgePlan`.
