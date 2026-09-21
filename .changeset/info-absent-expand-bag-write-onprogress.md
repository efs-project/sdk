---
"@efs/sdk": patch
---

Fix two read/write surface edge cases surfaced in review:

- **`fs.info(path, { expand: ['attestations'] })` on an absent path now returns an empty
  `attestations` bag instead of omitting the field.** The generic signature narrows
  `.attestations` to a non-optional field when `expand` opts in, but the absent-file
  branch omitted it — so a caller relying on the narrowed type would dereference
  `info.attestations` and get `undefined` at runtime. The runtime shape now matches the
  type (`exists: false` with `attestations: {}`).

- **`fs.write(path, bytes, { onProgress })` now actually invokes the callback.** The
  submit context forwarded the abort signal but never mapped `opts.onProgress` to the
  layered submitter's per-layer `onLayer` hook, so the documented progress callback never
  fired and progress-driven UI stalled until the final receipt. `onProgress` is now wired
  to fire once per DAG layer as it confirms (`{ step: layer, total: layerCount, phase:
  'layer-confirmed' }`).
