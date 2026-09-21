---
"@efs/sdk": patch
---

Two follow-on corrections: (1) list-pagination cursors now BIND their offset to the attester whose listing they index (`<offset>:<attester>`): resuming re-aligns the selection to the bound attester (continuing that listing exactly — no skip, no duplicate — even when it is no longer the ranked leader), and a cursor whose attester left the candidate set is void, restarting the ranked walk at offset 0 instead of silently applying a foreign offset to the new winner. Legacy bare-numeric cursors still parse and apply to the current selection. (2) `redirects.remove` now threads `IndexSendUnknown` onto `IndexingIncomplete.indexBroadcastUnknown` like `set` does — the previous wave's edit script had crashed before applying the remove-branch change, so a lost-response `indexRevocation` send reported `indexBroadcastUnknown: false`, a provably incorrect outcome for the documented recovery field.
