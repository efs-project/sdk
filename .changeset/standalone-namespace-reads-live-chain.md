---
"@efs/sdk": patch
---

The standalone-namespace read methods (`graph.tags.active`/`list`, `graph.pins.active`,
`props.list`, `mirrors.list`) now resolve the deployment from the LIVE provider chain, like
`fs.*` reads. They previously used the construction-time `publicClient.chain.id`, so on a
mutable EIP-1193 client that switched networks they could query old-chain contract addresses
on the new chain (false misses / wrong-chain metadata). Each namespace gained an optional
`liveDeployment` resolver used only by its reads; write methods keep the sync
`getDeployment` (the submit context's chain guard fails a drifted write closed).
