---
"@efs/sdk": patch
---

Fix two write-path edge cases surfaced in review:

- **`props.list` now enumerates property keys via the canonical, attester-independent
  anchor set** (`EFSIndexer.getAnchorsBySchema`) rather than the lens-scoped
  `getAnchorsBySchemaAndAddressList`. Because `props.set` reuses a "first-writer-wins"
  key-ANCHOR, a lens attester can bind an active value to a key whose anchor a
  *different* attester minted first. The old enumeration was scoped to the binding
  attester, so `props.get(data, key, { lens })` could return a value while
  `props.list(data, { lens })` omitted that key — a get/list divergence. Enumeration is
  now attester-independent; the lens-scoped value read continues to filter to the lens's
  active binding. Pagination is offset-based (anchors are non-revocable, so a full page
  always implies more).

- **`fs.write` now rejects a schemeless mirror URI up front** (typed `MissingTransport`),
  matching `efs.mirrors.add`. A URI with no `scheme:` prefix (e.g. `'not-a-uri'`) used to
  fall through to resolving the transport ROOT (`/transports/`), binding an unfetchable
  mirror — or reverting at the MIRROR layer after earlier attestations had already landed.
  An explicit `opts.transportDefinition` still wins.
