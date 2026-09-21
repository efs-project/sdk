---
"@efs/sdk": patch
---

fix(reads): fail closed on cross-chain DataRefs; enforce the byte cap while reading web3:// chunks

- **Cross-chain `DataRef`** — `fetchRef` now throws `WrongChain` when `ref.chainId`
  differs from the connected deployment's chain. EAS UIDs and `web3://` mirrors are not
  chain-qualified, so reusing a ref from another chain would have silently resolved a
  different deployment's mirrors/properties; it now fails closed before any read.
- **web3:// byte cap** — the `maxBytes` cap is threaded into the web3 reader, which now
  stops and throws as soon as the running chunk total exceeds it. Previously the bundled
  `readWeb3Bytes` accumulated every chunk (up to the ~96 MB scan cap) before the post-hoc
  size check, so an attacker-controlled on-chain mirror could force RPC work + allocation
  far beyond the configured cap. The post-read check stays as defense in depth.

Also corrected the `followRedirects` docs: only the DATA-sourced `sameAs`/`supersededBy`
kinds are followed today. `symlink` is ANCHOR-sourced (a path alias), so path-level
symlink resolution is deferred pending the ADR-0050 resolution-spec pin (the docs
previously implied `symlink` was auto-followed).
