---
"@efs/sdk": patch
---

Fix a batch of P1 correctness + quick-win findings from the SDK review:

- **`fs.info().verified`** no longer reports `'matches-author'` without ever hashing bytes — it returns `'unchecked'` (the honest status for a metadata-only read). `matches-author`/`mismatch` are reserved for the byte path (`read`/`readText`/…), which actually compares bytes.
- **Provenance read** (`resolvePlacement`'s placement-PIN lookup) no longer swallows RPC/transport errors into `ZERO_UID`. A legitimately empty slot still surfaces as no provenance; a transient RPC failure now propagates through the `classifyError` funnel instead of silently emptying provenance.
- **`CallStatus` and `OperationKind`** are now open unions (`| (string & {})`), matching `EfsErrorCode`/`TransportName`/`WriteMechanism`, so EIP-5792's evolving status wire format and new protocol op-kinds aren't a semver-major. Added `'redirect'` to `OperationKind` (the REDIRECT schema is frozen + in the registry).
- **Default IPFS gateways**: dropped the decommissioned `cloudflare-ipfs.com`; added `trustless-gateway.link` (kept `ipfs.io` + `dweb.link`).
- **`SYSTEM_LENS` read default**: a no-wallet, no-lens read now falls back to the deployment's SystemAccount instead of throwing `LensRequired`, so a public file reads in one line (`createEfsClient({ provider, chain }).fs.readText('/path')`). `LensRequired` is thrown only when even the SystemAccount is unavailable.
- **`list({ excludes })` honesty**: `excludes`/`minWeights` are marked `@experimental — not yet implemented` and the throw message now points at ADR-0011.
- **`NotImplemented`** accepts an optional `{ alternative, tracking }` so the message is a pointer, not a dead end. The `overview`/`preview`/`setOverview`/`batch` stubs now suggest a usable workaround.
- **Docs**: the package `README.md` quickstart is regenerated from the real surface (`read`/`readText`/`readBytes`/`readJson`/`locate`/`info`/`exists`/`list`/`write`); the old `efs.fs.read(...).data` + nonexistent `efs.fs.fetch` snippet is gone.
