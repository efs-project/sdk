---
"@efs/sdk": patch
---

Tier-1 writes now bind to an anchor slot that already exists instead of trying to mint it again, so a front-runner can no longer block a file write.

An anchor slot — a folder, a file path, or a property key such as the `contentType` of a file — is keyed by `(parent, name, bucket)` with no attester, and the EFSIndexer can only accept or reject a mint (EAS has already created the attestation by the time the resolver runs), so minting an existing slot reverts. A file write mints its DATA in one transaction and that DATA's reserved key anchors in the next; in between, the DATA UID is public. Anyone could claim `(DATA, "contentType", PROPERTY)` first, making the second transaction revert after the caller had paid for storage — and a retry minted a fresh DATA and re-opened the same window, so the write could be blocked indefinitely.

Binding to a claimed slot is safe because a slot holds only a name. Values are PROPERTY plus a binding PIN keyed to the signing attester, and readers resolve the slot without regard to who minted it — the same thing `efs.props.set` already does when updating an existing key. So before each layer is broadcast, the submitter now checks every planned ANCHOR's slot and binds to any that exists. If a slot is claimed while the layer is in flight (a simulation revert or a same-block revert), it re-checks and retries just that layer without the claimed anchor, never starting the write over. A front-runner can therefore cost at most one failed attempt per anchor and can never prevent completion. It never retries a user's rejection, and never retries a failure that no claimed slot explains.

`LayeredWriteResult` and `Tier1WriteResult` gain `reused` (slots bound to rather than created — kept out of `uids`, so a receipt never claims a slot someone else minted) and `revertedAttemptTxHashes`, which receipts now count in `signatureCount` because each cost the signer a confirmation.
