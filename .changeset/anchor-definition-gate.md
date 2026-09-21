---
"@efs/sdk": patch
"@efs/solidity": patch
---

The placement gates now validate BOTH sides of the PIN: `efs.graph.pins.place` and Solidity `EFSLib.place` verify the definition is an ANCHOR attestation (`NotAnchorUID` on the Solidity side, a typed `InvalidArgument` on the TS side) — EdgeResolver accepts any existing attestation as a PIN definition, but path resolution discovers placements by resolving an ANCHOR and only then reading its PIN slot, so a PROPERTY/DATA (or nonexistent) definition confirmed a placement no reader could ever find. The TS check batches into the same `Promise.all` as the target read (multicall-coalesced).
