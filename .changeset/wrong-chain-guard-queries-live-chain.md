---
"@efs/sdk": patch
---

The wrong-chain write guard now queries the wallet's LIVE chain (`getChainId()`) instead
of trusting the bound `wallet.chain`. A bound `chain` is fixed at client construction and
is not updated when an injected wallet switches networks, so a stale-but-matching bound id
could pass the preflight while the provider submits the write on its *current* network —
to deployment addresses resolved for a different chain. The guard now always asks the
provider's current chain before any write/revoke, closing that gap.
