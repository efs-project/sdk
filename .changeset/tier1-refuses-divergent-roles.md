---
"@efs/sdk": patch
---

`Tier1Submitter.submit` now refuses a context whose `roles` overrides diverge from the signing account, and derives the receipt's roles instead of taking them from the caller. Tier-1 is self-submitted by definition — one wallet signs, pays and broadcasts — so honoring an override stamped a false `author`/`signer`/`payer` onto a CONFIRMED receipt, the durable artifact third parties trust; a `submitter` override was even worse, recording that a relay stood in for the author when none existed. `submitter` is now absent on Tier-1 receipts. Rejected rather than silently dropped: a caller who set the override holds a wrong model of what this path does. Genuine payer/submitter divergence belongs to the deferred AA/relay submitters (mechanism `gateway`/`erc4337`), which are unaffected.
