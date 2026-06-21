---
"@efs/sdk": patch
---

fix(writes): resolve transport per mirror; fail closed on unimplemented `resume`

- **Per-mirror transport** — `fs.write` now resolves a `/transports/<scheme>` anchor for
  EACH mirror URI rather than deriving one from the first. A mixed-scheme durability set
  (e.g. `['ipfs://…', 'ar://…']`) previously published every later URI under the first
  URI's transport anchor, writing permanently-wrong transport metadata. The write-graph
  builder's `mirrors` input now carries `{ uri, transportDefinition }` per entry (the
  Solidity `Mirror` struct already modeled this). An explicit `opts.transportDefinition`
  still applies to all entries.
- **`resume` fails closed** — `fs.write` now throws `NotImplemented` when `opts.resume` is
  supplied. Resume was accepted but ignored: it re-submitted a fresh plan with an empty UID
  map, re-sending already-landed layers and double-minting DATA/MIRROR/PROPERTY/ANCHOR
  records on a partial-write retry. It will be re-enabled once it seeds/skips from the
  receipt's landed UIDs.
