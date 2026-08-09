---
"@efs/sdk": patch
---

Guard the last two write-path planning reads against a drifted public chain:

- **`setOverview`** re-asserts the live chain before resolving the `/tags/system` marker
  definition. That UID is embedded in the plan as the Overview `system` TAG, and
  `writeFileTier1` only re-asserts after it is already baked in — a drifted provider could
  otherwise tag the README with a non-canonical `system` anchor (so `SAFETY_EXCLUDES` won't
  hide it) or fail after earlier work.
- **`mirrors.add`** re-asserts before `resolveMirrorTransport`'s on-chain
  `/transports/<scheme>` fallback (taken when the deployment map lacks the URI's scheme),
  reusing the submit context for the guard and the submit. A drift could otherwise build a
  MIRROR plan with a wrong-chain transport UID. (Completes the standalone-write planning-read
  sweep — `mirrors.add` was the verb missed earlier.)
