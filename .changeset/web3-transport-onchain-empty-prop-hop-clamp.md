---
"@efs/sdk": patch
"@efs/solidity": patch
---

fix: resolve web3 transport on-chain for default writes; round-trip empty property values; clamp Solidity redirect hops

- **`@efs/sdk` (P1) — default `web3://` write works on Sepolia.** `transportDefinitionFor` now
  falls back to resolving the `/transports/<scheme>` anchor ON-CHAIN when the deployment's
  `transports` map lacks it (matching `efs.mirrors.add`). The built-in Sepolia entry has no
  `transports` map, so a default no-mirror `fs.write` previously threw `MissingTransport`; it now
  resolves `/transports/web3` on-chain.
- **`@efs/sdk` (P2) — empty property values round-trip.** `decodePropertyValue` no longer coerces a
  decoded empty string to `undefined`, so `efs.props.set(uid, key, '')` is readable by
  `props.get`/`props.list` (absence is the missing property/binding UID, not an empty value).
- **`@efs/solidity` (P2) — bounded redirect hops.** `EFSReader.resolveWithRedirects` clamps `maxHops`
  to the 32-hop ceiling, so a hostile value can't overflow `cap + 1` or force a huge `visited`
  allocation.
