---
"@efs/sdk": patch
---

Corrected the `WriteOptions.mirrors` documentation: each entry selects its own transport definition from its OWN URI scheme, not the first entry's. The implementation has resolved per-entry since mixed-scheme durability sets were supported, so a caller following the old contract could provision only the first scheme and then hit an unexpected `MissingTransport` on a later mirror. The doc now states the per-entry rule, that every scheme used needs a recorded anchor, and that an explicit `transportDefinition` overrides the lookup for all entries. Documentation only — no behavior change.
