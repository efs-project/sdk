---
"@efs/sdk": patch
---

fix: strict list lens scoping, http gateway guard, plan-before-deploy, reject zero list limit

- **List reads stay scoped to an explicit lens.** `efs.lists.entries`/`length`/`has` only fall
  back to the curator when NO lens intent was expressed (no per-call lens, no client
  `defaultLens`, no connected account). A caller reading with lens Alice no longer receives
  curator Bob's entries when Alice's view is empty.
- **Reject `http://` gateway URLs.** The plaintext-HTTP guard now runs for EVERY concrete fetch
  URL, so an `http://` entry in `ipfsGateways`/`arweaveGateways` is blocked unless
  `allowInsecureHttp` is set (previously only direct `http://` mirrors + redirects were guarded).
- **Plan before deploying bytes.** `fs.write` runs the read-only ancestor visibility-tag planning
  BEFORE the irreversible on-chain SSTORE2 storage deploy, so a failing `getActiveTagWeight` read
  aborts before any gas is spent.
- **Reject non-positive list-entry limits.** `efs.lists.entries({ limit: 0 })` (and `.byPage({ limit: 0 })`)
  threw the iterator into an infinite no-progress loop; they now throw `InvalidArgument`.
