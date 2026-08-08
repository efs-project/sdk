---
"@efs/sdk": patch
---

Three review fixes (one P1): a response with NO readable stream now FAILS the attempt instead of falling back to `arrayBuffer()` — the fallback buffered the entire attacker-sized body before any cap check ran (Content-Length is attacker-controlled and may be absent/understated), defeating the documented hard ceiling; every real fetch implementation streams, so bodyless responses are mock territory and failover proceeds. `timeoutMs` is bounded by the platform timer ceiling (`MAX_TIMEOUT_MS = 2_147_483_647`, new export) — larger values truncate to ~1 ms and aborted every attempt immediately. And CUSTOM abort reasons (`controller.abort('user cancelled')` — a string/object with no `name`) propagate verbatim: both the engine and the read path check `signal.throwIfAborted()` first instead of relying on an Error-shaped name.
