---
"@efs/sdk": patch
---

Extend the write-path chain guard to the file-write planning reads and the receipt waits —
the last drift windows in a multi-step write:

- **`writeFileTier1`** re-asserts the live chain after the caller's entry preflight and
  before its planning reads (parent-anchor resolution, visibility tags, transport
  definitions). A provider that switched chains for those reads — then back before
  storage/submit — could otherwise bake wrong-chain anchor/transport UIDs into the plan.
- **`submitLayeredTier1`** re-asserts before each layer's `waitForTransactionReceipt`
  (inside the wait try): a provider that drifts after the tx is broadcast no longer waits on
  the wrong chain and falsely reports a mining tx as a partial failure — the drift surfaces
  as the honest outcome-unknown `WriteRevertedError(mined:false)` carrying the in-flight
  txHash, so recovery can re-bind and check it.
- **`storeOnchain`** re-asserts before each deploy's receipt wait (`requireContractAddress`),
  so a drift after the chunk/manager broadcast fails closed with `WrongChain` instead of a
  misleading "no contract address" that aborts the default no-mirror write.
