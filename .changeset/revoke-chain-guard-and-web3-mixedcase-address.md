---
"@efs/sdk": patch
---

Two fixes:

- **The wrong-chain write guard now covers revokes/removes.** `graph.tags.remove`,
  `graph.pins.unplace`, `mirrors.remove`, `redirects.remove`, `lists.remove`, and the raw
  `efs.eas.attest`/`multiAttest`/`revoke` escape hatch all route through `makeEasVerbs`,
  which previously bypassed the chain assertion added for the add/set/create paths — so a
  wallet on a different chain than the deployment could send a no-op/wrong-chain EAS revoke
  while the real attestation stayed active. `makeEasVerbs` now runs the same fail-closed
  `WrongChain` preflight before every write tx.
- **`web3://` reads accept router-valid mixed-case addresses.** A mirror address with
  arbitrary mixed-case hex but no valid EIP-55 checksum (legal for the router, which parses
  case-insensitively) made `parseWeb3Uri` throw `InvalidAddress` from `getAddress`, failing
  reads when it was the only mirror. The hex is now lowercased before checksumming.
