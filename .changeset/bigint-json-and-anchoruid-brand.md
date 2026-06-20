---
"@efs/sdk": patch
---

DX polish (review P3): a bigint-safe JSON serializer + an `AnchorUID` brand.

- **`efs.toJSON(value, space?)` + the exported `jsonReplacer`.** EFS result DTOs carry `bigint`s — `FileInfo.size`, `ListConfig.maxEntries`, the TAG weight reads, `WriteEstimate.gas`, the EAS `Attestation` time fields — and bare `JSON.stringify` THROWS on a bigint (`TypeError: Do not know how to serialize a BigInt`). That surprised devs the first time they logged a receipt, persisted a result, or handed a DTO across a serialization boundary (TanStack Query's cache, a Next.js Server→Client component prop, `res.json(...)`). `efs.toJSON` (and the lower-level `jsonReplacer`, a plain `JSON.stringify` replacer) render those bigints as decimal strings. Present on read-only clients too; pure + stateless. Documented round-trip caveat: serialization is lossy of the bigint TYPE — bigints come back as strings on `JSON.parse`, not bigints (there is no safe automatic reviver), so the consumer re-`BigInt(…)`s the fields it knows are numeric (same as viem/wagmi at the JSON boundary).

- **`AnchorUID` brand.** A folder ANCHOR's UID is now branded distinctly from `DataUID` (review P3 / A11): `DirEntry`'s dir variant carries `anchorUID: AnchorUID`, its file variant carries `dataUID: DataUID`. Catches the wrong-UID-kind integration bug at the type level — passing a folder anchor where a file's DATA UID is expected. Both are `Hex` at runtime (zero cost); the distinction is type-only. `AnchorUID` is exported alongside `DataUID`.

New exports: `toJSON`, `jsonReplacer`, `AnchorUID`. No runtime behavior change to existing verbs; no bundle-size-relevant code on the read/write hot paths.
