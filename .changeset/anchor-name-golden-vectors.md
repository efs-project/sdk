---
---

Test-only: shared golden vectors for the canonical anchor-name encoding (`test/fixtures/anchor-names.vectors.json`), checked against `encodeName`/`decodeName`/`asCanonicalName`. The contracts suite consumes the same file to keep `EFSIndexer` and the router's path canonicalization byte-aligned with the SDK. No published code changes.
