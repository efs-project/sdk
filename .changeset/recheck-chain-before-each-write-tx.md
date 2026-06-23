---
"@efs/sdk": patch
---

Re-assert the live chain before EVERY wallet transaction in a multi-tx write, not just
once at preflight. A single logical write fires many wallet confirmations — the two
on-chain storage deploys (chunk + manager) and one `multiAttest` per dependent DAG layer.
An injected wallet can switch networks between any two prompts; the old single preflight
let a later step broadcast to the new chain while receipts were still awaited on the
deployment chain, leaving a wasted/orphaned deploy or a partial attestation write.

- `submitLayeredTier1` now runs the chain guard before each layer's `multiAttest` (threaded
  through `SubmitContext.assertChain`), so the file write, `setOverview`, and the standalone
  edge/value writes (`graph.tags`/`graph.pins`/`props`) all fail closed with `WrongChain` on
  the dependent layer rather than sending it to the wrong chain.
- `storeOnchain` re-checks before the chunk deploy AND between the chunk and manager deploys
  (`OnchainStoreContext.assertChain`), so a switch after the chunk lands stops the manager.

The standalone edge writes drop their now-redundant single preflight — the per-layer guard
covers the first layer too.
