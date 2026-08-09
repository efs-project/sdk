---
"@efs/sdk": patch
---

Mirror preflight now parses `web3://` locators with the strict `parseWeb3Uri` validator. `resolveTransport`'s web3 branch deliberately defers address parsing to the chain reader, so the previous structural check accepted `web3://0x1234` — a file could confirm with that as its only retrieval method and then fail every read. Read behavior is unchanged (reads still tolerate what the router tolerates); this is a write-side preflight only.
