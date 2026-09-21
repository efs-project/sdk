---
"@efs/sdk": patch
---

fix(reads/writes): cap Overview fetch at the render limit; hydrate DataRef expand; reject unbound wallets

- **Overview render cap.** `efs.fs.overview` now passes `maxBytes: MAX_RENDER_BYTES` into the
  fetch. The pre-fetch `size`-PROPERTY check is best-effort and an untrusted Overview can lie
  about it (missing/malformed/under-reported), so the cap is now enforced during the fetch —
  the reader stops buffering past `MAX_RENDER_BYTES` instead of letting an attacker force a
  huge folder header. `FetchOptions.maxBytes` is now a public read option, forwarded to the engine.
- **DataRef `expand` hydration.** `read(ref, { expand: ['attestations'] })` (the common
  `locate() → read(ref)` two-step) previously skipped hydration on the DataRef early return, so
  `file.attestations` was `undefined` even though the generic signature narrows it to set. It now
  routes through the same expansion (hydrating the contentHash record; placement is absent, since
  a bare ref has no PIN).
- **Unbound wallet.** `fs.write` now throws `WalletRequired` when the wallet client has no bound
  account, instead of attesting under the zero address (lenses, visibility planning, and the
  receipt's `resolvedBy` all key on the real attester). Matches the edge-write gate.
