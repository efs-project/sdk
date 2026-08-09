---
"@efs/sdk": patch
---

Two fixes: (1) The submitter's hardlink gate now also verifies the target IS a DATA attestation — the builder stamps the plan with `FileWriteGraph.dataSchemaUID`, and `submitWriteTier1` compares it against the target's actual schema before broadcasting (a self-authored ANCHOR/PROPERTY target previously produced a confirmed receipt for a file no SDK reader can find; Solidity parity: `EFSLib.NotDataUID`). A hardlink plan without the stamp fails closed. (2) The raw EAS verbs (`attest`/`multiAttest`/`revoke`) apply the same refusal-vs-transport send split as every other send path: a code-less transport failure now throws the new `EasSendUnknown` (op-tagged; broadcast state unknown, may still mine, blind retries duplicate or revert `AlreadyRevoked`) instead of an ordinary classified error, while response-backed refusals stay classified.
