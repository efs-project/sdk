---
"@efs/sdk": patch
---

Reserved property values are now validated by a single shared rule that every entry point calls, instead of a check per door.

The exported `buildFileWriteGraph` encodes `contentType` straight into the reserved PROPERTY and produced a plan the submitter mines happily, so a direct caller could persist `'not-a-media-type'` — or a media range like `text/` + wildcard — as authoritative metadata that makes `fs.overview()` misclassify the file. That was the third public door onto the same value: `fs.write`'s options and `efs.props.set` were guarded in earlier fixes, one at a time, each leaving the next open.

`assertReservedPropertyValue` now holds the whole reserved-key contract (`contentType`, `contentHash`, `size`) and is called from `buildPropertyPlan` and from the graph builder's reserved-property construction. Non-reserved keys are untouched — this is a reserved-key contract, not a value policy for every property. Note the byte-write path already verified `contentHash` and `size` against the supplied bytes, which is stronger than a canonical-form check; those guards are unchanged and now pinned by tests so the shared assertion cannot silently weaken them.
