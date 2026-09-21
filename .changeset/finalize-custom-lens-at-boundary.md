---
"@efs/sdk": patch
---

`resolveLens` now finalizes EVERY lens's resolved output at the common boundary — deduplicating (case-insensitive, order-preserving) and enforcing `MAX_LENSES` with the typed `MaxLensesExceeded`. Previously only the built-in `lens()`/`identity()` constructors finalized internally, so a caller-supplied custom `Lens` object could feed duplicates or 21+ attesters straight into reads like `locate()`/`read()`, failing with an opaque contract/RPC error instead of the documented one and violating `resolveAttesters()`'s promised deduped result. Idempotent for the built-ins.
