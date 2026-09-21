---
"@efs/sdk": patch
---

Two fixes: (1) `props.list`'s `maxKeys` can only LOWER the scan ceiling, never raise it — `maxKeys: 1_000_000` previously replaced `MAX_PROPERTY_SCAN` and re-opened the unbounded enumeration the default exists to prevent; non-positive or non-integer values are now rejected. (2) Mirror-URI preflight treats `http` as a known scheme (`resolveTransport` supports it behind `allowInsecureHttp`), so a malformed `http://` locator no longer slips through as an unknown/custom scheme; it is parsed with the opt-in enabled, validating structure at write time without imposing the reader's insecure-transport policy on the write.
