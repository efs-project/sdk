---
"@efs/sdk": patch
---

Redirect reads recheck revocation at the EAS decode: the active-only indexer scan and the follow-up `getAttestation` are two reads, so a revoke landing between them was still honored for one more read by `redirects.get`/`list`, canonicalization, history, and the symlink walk. The shared record fetch now reads `revocationTime` in the same lookup and discards a retracted redirect as absence.
