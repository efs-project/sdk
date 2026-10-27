---
---

CI-only: the anchor-name conformance vectors are now owned by efs-project/contracts (next to specs/02). The SDK keeps a byte-identical copy, and a new CI step (`scripts/check-name-vectors-drift.mjs`) fails when it differs from contracts `main`. No published code changes.
