---
"@efs/sdk": patch
---

The SSTORE2 chunk deploy gets the same send-outcome honesty as the manager leg and the layered submitter: a code-less transport failure during the chunk send (connection drop after the request may have reached the node) now throws the new `OnchainSendUnknown` — broadcast state unknown, the deploy may still mine and bill gas, no hash to reconcile by — instead of an ordinary classified error that invited a `fs.write` retry paying for duplicate storage. A refusal response (wallet/node error code, decoded revert) still propagates as the classified error, where a retry is clean.
