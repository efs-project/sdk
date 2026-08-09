---
"@efs/sdk": patch
---

Mirror transport definitions are now preflighted before layer 1 broadcasts. The pure builder shape-checks each `transportDefinition` (nonzero bytes32) and stamps the plan's distinct transport UIDs; the submission boundary then verifies MirrorResolver's actual predicate — each definition must be an ANCHOR attestation descending from `/transports/` (walking parents via each anchor's `refUID`, the same edge the contract's `getParent` reports, under the contract's depth bound). Previously an arbitrary or non-`/transports/` definition passed the builder, mined the DATA + file-ANCHOR layer, and only reverted at the layer-2 MIRROR — a paid partial graph. The gate is skipped for plans without mirrors and fails closed when the context cannot read.
