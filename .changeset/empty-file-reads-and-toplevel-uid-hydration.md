---
"@efs/sdk": patch
---

Two read-path correctness fixes:

- **Empty files (`size` attested `0`) read correctly.** `fetchRef` clamps the fetch cap to the
  author's declared `size`, but for a legitimately empty file that clamped the cap to `0`, which
  `fetchVerified`'s cap validation then rejected — so a default verified read of an empty file
  (`fs.write('/empty', new Uint8Array())`) failed before any mirror was tried. The declared size
  now lowers the cap only when positive; an empty body verifies against the empty-SHA-256 claim
  under the default cap.
- **`attestationsFor` hydrates top-level item UIDs.** `HasSourceUIDs` accepts `ref.uid` /
  `dataUID` / `anchorUID`, but the batch-hydrate only flattened the `sourceUIDs` bag and skipped
  items that had only those top-level fields — so `DirEntry` (from `fs.list()`) and `DataRef`
  DTOs returned an empty `attestations` map. The loop now also collects the top-level UIDs
  (`dataUID`/`ref.uid` → `data`, `anchorUID` → `anchor`; the bag wins on a key collision).
