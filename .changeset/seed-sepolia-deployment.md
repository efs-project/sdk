---
"@efs/sdk": patch
---

feat(chain): seed the live Sepolia (11155111) deployment in the built-in registry

The built-in registry was empty, so `createEfsClient({ provider, chain: sepolia })` threw
`DeploymentNotFound` even though Sepolia froze on 2026-06-19. Seeded the canonical addresses
+ nine frozen schema UIDs from the contracts repo `docs/CHAINS.md` (EFSIndexer/EdgeResolver/
MirrorResolver/ListResolver/ListEntryResolver/AliasResolver/SystemAccount proxies +
EFSFileView/EFSRouter/ListReader views + EAS/SchemaRegistry). `resolveDeployment(11155111)`
now returns it (regression-tested); reads work out of the box.

`transports` is intentionally omitted — the per-scheme `/transports/<scheme>` anchor UIDs are
runtime EAS UIDs not derivable offline and not in `docs/CHAINS.md` (only the `/transports`
root is). A default on-chain (`web3://`) write therefore needs `WriteOptions.transportDefinition`
until those are seeded; everything else works.
