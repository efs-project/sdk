---
"@efs/sdk": patch
---

Two follow-up fixes to the previous round's hardening.

CID varints are now decoded without 32-bit bitwise arithmetic. JavaScript's `<<` and `|=` coerce to int32, so a five-byte varint silently lost its high bits: `81 80 80 80 10` encodes 4294967297 but read back as version 1, and the new minimality guard could not see it — a base16 URI carrying that sequence passed the whole write preflight even though CID parsers and gateways reject the unsupported version. The accumulator now multiplies instead of shifting, and any field exceeding uint32 is refused.

The Overview system TAG definition is now pinned to the deployment's canonical `/tags/system` anchor rather than merely checked for being *some* ANCHOR. A direct caller supplying any other real tag definition — `/tags/nsfw`, say — would mine the TAG under the wrong definition, and because directory reads resolve the `system` exclusion to the canonical `/tags/system` UID, the README would remain visible in safety-filtered listings: the Overview contract quietly unfulfilled rather than loudly broken. The boundary now resolves `/tags/system` through the indexer and requires a match, failing closed when it cannot. `SYSTEM_TAG_PATH` moved to `types.ts` so the submit boundary can reference it without an import cycle; `writes/overview.ts` re-exports it, so the public name is unchanged.
