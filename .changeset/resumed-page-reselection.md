---
"@efs/sdk": patch
---

List pagination's evaporated-leader failover now covers RESUMED cursors: an empty page at a nonzero offset is disambiguated with a live `length` read — a standing leader's empty page stays the honest end of pagination, while an evaporated leader (entries revoked after the selection probe) falls through to the next ranked lens candidate, restarting at offset 0 since the persisted cursor indexed the evaporated attester's listing. Previously the failover was restricted to offset zero, so a resumed listing could report a false end while a lower-priority attester held entries.
