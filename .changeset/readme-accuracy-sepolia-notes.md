---
"@efs/sdk": patch
---

README accuracy: `fs.overview`/`setOverview` and `list({ excludes })` are implemented (they were still listed as "coming"), `efs.sorts` is added to the not-yet-implemented list, and the README now states the practical write limits on Sepolia (on-chain storage size, several confirmations per file) and how files carrying a pre-ADR-0016 bare-digest `contentHash` read back. Also corrects the Sepolia registry note: writes resolve `/transports/<scheme>` on-chain, so no `transportDefinition` is needed.
