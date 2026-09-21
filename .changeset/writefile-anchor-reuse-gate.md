---
"@efs/solidity": patch
---

`EFSLib.writeFile` validates a reused `existingFileAnchorUID` BEFORE minting the DATA graph: a PROPERTY/DATA/nonexistent reused UID now reverts `NotAnchorUID` up front — previously the full write confirmed (and `_efsWriteFile` emitted `EFSFileWritten`) for a placement path resolution can never discover, with the whole attestation graph already minted. This closes the last placement funnel missing the definition gate.
