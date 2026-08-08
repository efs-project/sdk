---
"@efs/sdk": patch
---

The mirror transport-anchor check now runs before the orchestrated write's PAID storage deploys, not just at the submission boundary. `fs.write`'s auto-store path resolved the transport, deployed the SSTORE2 chunk + manager, and only later hit the boundary gate — so a well-shaped but invalid `opts.transportDefinition` (or a stale deployment-map UID) left the caller paying for orphaned storage on a write that could never complete. Both paths now share one implementation (`assertTransportAnchors`): ANCHOR schema plus `/transports/` ancestry within the contract's depth bound.
