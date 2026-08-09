---
"@efs/sdk": patch
---

Guard the standalone write verbs' PLANNING reads against a drifted public chain, before they
feed the plan. `props.set` (key-anchor `resolveAnchor`), `graph.tags.add` (definition
resolution), and `lists.add` (config→targetType) each ran a public-client read whose result
shapes the attestation plan BEFORE `submitEdgePlan` reached its chain guard. A mutable
EIP-1193 public provider on a different chain (while the wallet is back on the deployment
chain for submission) could resolve a UID/config that only exists on the wrong chain, so the
plan reuses an anchor absent on the deployment chain — layer 1 mints, layer 2 reverts
referencing it (a partial write). Each verb now runs the submit context's `assertChain`
(fail closed with `WrongChain`) BEFORE the planning read, reusing the same context for the
submit. `lists.remove`'s advisory append-only config read is guarded the same way. `pins`,
`redirects`, and `lists.create` build plans purely from arguments and need no pre-read guard.
