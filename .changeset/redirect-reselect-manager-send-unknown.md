---
"@efs/sdk": patch
---

Two follow-on hardening fixes: (1) redirect selection now decodes an attester's candidates in ascending-UID order until one survives the EAS revocation recheck — previously only the preselected lowest UID was decoded, so a revoke racing between the scan and the decode made the selection fall through to a lower-priority attester even though the winning attester still asserted other active redirects (breaking first-attester-wins). (2) The on-chain storage path gets the same refusal-vs-transport send split as the layered submitter: when the chunk-manager deploy's send fails WITHOUT a response, `OnchainStoreIncomplete` now carries `managerBroadcastUnknown: true` and its message says the deploy may still mine and to check the account's pending txs/nonce before re-wrapping — instead of confidently asserting the manager was never broadcast and recommending an immediate (possibly duplicate) re-wrap. Pre-send guard failures (abort, chain drift) remain definite.
