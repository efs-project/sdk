---
"@efs/sdk": patch
---

The padded multibase codes (`c` base32pad, `C`, `t` base32hexpad, `T`) are now refused by name at the write preflight instead of being decoded with the ordinary unpadded routine. Swapping a valid base32 CID's `b` prefix for `c` spells base32pad WITHOUT the `=` padding multibase requires, and it passed the preflight — so it could be minted as a file's only mirror while strict multibase/IPFS implementations reject the locator outright. Parsing the padding instead would not help: `=` is non-alphanumeric, and the `ipfs://` reader refuses those characters so a crafted CID cannot smuggle path or host characters into a gateway URL, which means a correctly padded CID could never be read back either. The error names the base and tells the caller to re-encode as base32 (`b…`) or base58btc (`z…`), rather than reporting an "unknown" prefix for a code that is genuinely assigned.
