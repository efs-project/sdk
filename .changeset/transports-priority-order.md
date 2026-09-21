---
"@efs/sdk": patch
---

`FetchOptions.transports` now honors its documented "Restrict/**prioritize**" contract: the caller's ordered preference reorders the candidate mirrors instead of only filtering them. The fetch engine takes the first mirror that yields bytes, so `transports: ['https', 'ipfs']` previously had no effect on selection at all when the on-chain mirror list happened to list IPFS first. Ordering is stable within a scheme, so the on-chain priority still breaks ties between same-scheme mirrors, and duplicate entries take their first-mentioned rank.
