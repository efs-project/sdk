---
---

Test-only: the live fork round-trip now asserts the exact `contentHash` PROPERTY string `fs.write` puts on-chain (`f1220` + SHA-256 hex, computed independently with `node:crypto`), not just that it verifies. Closes the last acceptance criterion of sdk#2. No published code changes.
