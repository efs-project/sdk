# @efs/solidity

## 0.1.0

### Minor Changes

- c3452c5: The EFS **v1 profile boundary** (ADR-0019, the Aug-7 review's R1–R6): the implementation is now EXPLICITLY the v1 profile, so a future v2 (a carrier replacement — EAS dropped, logical IDs, 5 kinds) lands beside it instead of silently reinterpreting persisted v1 state. `createEfsV1Client()` is the canonical factory (`createEfsClient` stays as a deprecated one-cycle alias — same function); the client carries `readonly profile: 'efs/v1'` (`EFS_PROFILE_V1`), with `EfsV1Client`/`EfsV1ReadClient`/`EfsV1ClientConfig` aliases and the `EfsV1ProtocolSurface` type naming the EAS-scoped namespaces ("stable verbs, versioned result envelopes"). Persisted artifacts are stamped: `DataRef`, `WriteReceipt`, and `FileWriteGraph` gain required `profile: 'efs/v1'` (a v1 EAS UID and a v2 logical ID are both bytes32 — only the stamp tells them apart). NEW durable serializers in `artifacts.ts` (`serializeDataRef`/`parseDataRef`, `serializeWriteReceipt`/`parseWriteReceipt`): versioned envelopes, lossless tagged bigints, fail-closed `UnsupportedArtifact`/`MalformedArtifact` (new errors/codes), opaque-extension preservation — and `efs.toJSON` is now documented as logging-only (its output is deliberately rejected by the parsers). BREAKING renames vs the unreleased scaffold: `WriteOptions.lens` → **`author`** (a lens is reader policy; `author` is the vocabulary v2 keeps), and `WriteReceipt` gains required `roles: WriteRoles { author, signer, payer, submitter? }` — one EOA fills every role on Tier-1 (output-only), with `SubmitterContext.roles` as the AA/relay divergence seam. `@efs/solidity`: sources move to **`src/v1/`** and the exports map narrows to `./src/v1/*.sol` — the profile is explicit in every import path while symbols stay clean (`EFSLib`, not `EFSLibV1`).

### Patch Changes

- 1a7d14e: The placement gates now validate BOTH sides of the PIN: `efs.graph.pins.place` and Solidity `EFSLib.place` verify the definition is an ANCHOR attestation (`NotAnchorUID` on the Solidity side, a typed `InvalidArgument` on the TS side) — EdgeResolver accepts any existing attestation as a PIN definition, but path resolution discovers placements by resolving an ANCHOR and only then reading its PIN slot, so a PROPERTY/DATA (or nonexistent) definition confirmed a placement no reader could ever find. The TS check batches into the same `Promise.all` as the target read (multicall-coalesced).
- 414fa0b: The placement-gate matrix completes: (1) the DATA-bucket check is now UNCONDITIONAL in the TS gates — the layered boundary and `pins.place` decode every placement anchor's `(name, forSchema)` payload and refuse anchors outside the DATA file bucket even on standalone plans with no requested slot (a generic-folder or PROPERTY-key ANCHOR passed the schema check but file resolution only discovers DATA-bucket terminals). (2) Solidity `writeFile` and the six-argument `placeExisting` bind reused anchors to the requested `(parent, fileName, DATA)` slot via the shared `_requireAnchorNamesSlot` (reverting the new `AnchorSlotMismatch`), and the standalone `place` enforces the DATA bucket (`NotFileBucketAnchor`) — a valid ANCHOR from another slot previously let the transaction and `EFSFileWritten` confirm while a different path was overwritten or nothing discoverable was placed.
- b4f4a1a: Reused concrete file-ANCHORs are now validated before broadcast: (1) the builder stamps plans with `anchorSchemaUID` + `existingAnchorUID` when an overwrite/relink reuses a concrete anchor, and `submitLayeredTier1` verifies the reused definition IS an ANCHOR attestation (fail-closed on a missing stamp or a read-incapable context) — an arbitrary `existingFileAnchorUID` executed through the exported layered submitter previously skipped the anchor mint and could confirm a placement `fs.*` can never discover. (2) Solidity's six-argument `placeExisting` applies the same `NotAnchorUID` check to a nonzero reused anchor before attesting the PIN. For `fs.write` (which resolves the UID via `resolveAnchor` — an ANCHOR by construction) this is one extra defense-in-depth read per overwrite.
- 6ba6eb7: `contentHash` now conforms to the ratified v1 encoding (contracts specs/10, SDK ADR-0016 superseding ADR-0006). `hashContent` emits the canonical multibase-base16 multihash string — `f1220` + 64 lowercase sha2-256 hex chars (69 chars) — instead of a bare digest, and the `ContentHash` brand now means that canonical string. The read path gains an algorithm-aware accepted-form decoder (`decodeContentHash`, new export with `CONTENT_HASH_CODES`): `f`/base16 and `b`/base32 (RFC 4648 lowercase, no padding) forms of the two registered functions (`0x12` sha2-256 canonical, `0x1b` keccak-256 alternate) decode, and `verifyContent` compares at DIGEST level, so a base32 or keccak-alternate claim of matching content verifies `matches-author`. Bare digests (the old ADR-0006 form), `0x`-prefixed values, uppercase, and unregistered codes report `malformed-claim` — deliberately, with no bare-digest tolerance: no SDK-written durable data exists, and the only legacy Sepolia population (debug-UI `0x`-keccak values) already read `malformed-claim` before. The mirror engine's `statusFor` now delegates to `verifyContent` (one decode/verify implementation). `FileWriteGraphInput.contentHash` is typed as `ContentHash` so a non-canonical string cannot re-enter the non-revocable PROPERTY persistence path. specs/10 §7 conformance vectors imported as tests. `@efs/solidity`: `EFSLib.ReservedKey` doc updated to the canonical form (comment-only).
- 512878e: Close the two gaps left by the previous mirror fixes. The IPFS CID check no longer has an alphabet-only path: every accepted multibase (base2/8/10/16/32 families, base36, base58btc, base58flickr) is really decoded and the bytes face the same version/codec/multihash parse, so `ipfs://k0000000000` — well-formed base36, not a CID — is refused. And the Solidity SDK's `_requireActiveMirror` now scans the newest 500 raw slots like the TypeScript reader and `EFSRouter`, instead of the oldest 500: an active mirror stranded below the readable window no longer lets a placement through, and one past the 500th slot no longer blocks a readable DATA.
- 1042784: fix: file anchors must be DATA-typed (`forSchema = DATA_SCHEMA_UID`), not generic

  A FILE's terminal path anchor was encoded with generic `forSchema = bytes32(0)`. The
  EFSIndexer keys anchors by `(parent, name, forSchema)`: the router resolves a file's
  terminal segment via `resolveAnchor(parent, name, DATA_SCHEMA_UID)` and directory
  listing enumerates only `_childrenBySchema[parent][DATA_SCHEMA_UID]`, so a file written
  generic landed in the FOLDER bucket — invisible to file listings and colliding with a
  same-named folder (a naive single-file `locate` masked it via the router's generic
  fallback). Now `graph.ts`'s file anchor and `EFSLib.writeFile`/`placeExisting` encode
  `schemas.data`. FOLDER anchors correctly stay generic. The Solidity `FileWrite.forSchema`
  field and `placeExisting(..., forSchema)` param are removed (a file is always DATA-typed;
  the field was a footgun). Verified against the deployed contracts + the canonical seed.

- 22ba660: fix(solidity): property key-anchors must use `PROPERTY_SCHEMA_UID` as `forSchema`, not generic `bytes32(0)`

  `forSchema` is the third key of the EFSIndexer anchor directory
  (`_nameToAnchor[parent][name][forSchema]`), so it is load-bearing for resolution,
  not cosmetic. `EFSLib.writeFile`'s reserved-key loop and `EFSLib.setProperty` were
  filing property key-anchors under a generic `forSchema`, landing them in a
  different slot than every spec-conformant reader looks up — including
  `EFSRouter._getContentType`, which resolves via
  `resolveAnchor(DATA, key, PROPERTY_SCHEMA_UID)`. Result: properties (incl. a
  file's `contentType`/`contentHash`/`size`) written through the Solidity SDK were
  invisible to the router and to the TS SDK's `props.get`/`props.list`. Now both
  write sites pass `schemas.property`, matching the spec, the seeded fixtures, the
  EFSRouter, and the TS SDK. Folder/file path-node anchors correctly keep generic
  `forSchema`.

- fd99b46: fix: fs.list honors initial cursor + rejects zero limits; Solidity listChildren enumerates children

  - **`@efs/sdk` — `fs.list` initial cursor.** A caller resuming with `efs.fs.list(path, { cursor })`
    now starts the first page/iteration at that cursor instead of restarting at offset 0 (byPage and
    the iterator fall back to `opts.cursor` when no per-page cursor is supplied).
  - **`@efs/sdk` — reject zero per-page directory limit.** `fs.list(path).byPage({ limit: 0 })` now
    throws `InvalidDirectoryQuery` instead of passing `maxItems: 0` to the view (a contract revert / a
    non-progressing empty page).
  - **`@efs/solidity` — `EFSReader.listChildren` enumerates a folder's children.** It forwarded to
    `getFilesAtPath` (active DATA placements AT the anchor), so a normal directory with children but
    no DATA pinned returned empty. It now calls `getDirectoryPageBySchemaAndAddressList`.

- 29139e1: The foreign-hardlink family closes out: (1) `buildFileWriteGraph`'s input is now a discriminated union — `FileWriteHardlinkInput` carries NO retrieval metadata by design (the reserved key-ANCHORs are canonical attester-independent PERMANENT slots, so a pure builder re-emitting the triplets for any previously-written DATA would revert the whole layer), and the hardlink branch REJECTS stray metadata at runtime with guidance instead of silently discarding it: the placer must already have authored the DATA and its metadata (self-dedup), or re-publish the bytes / attest metadata via `efs.mirrors.add` / `efs.props.set` after placing. (2) Solidity `EFSLib.place` — the standalone hardlink/move primitive the README advertises — now applies the same `ForeignDataUID` self-authorship gate as `placeExisting`, so a foreign placement reverts instead of producing a visible-but-unreadable file.
- a11c6fc: Two hardlink fixes: (1) Solidity `EFSLib.placeExisting` now reverts `ForeignDataUID` unless the DATA was authored by the calling contract — lens-scoped reads key mirrors and content-hash/type properties on the placement attester, so a hardlink to foreign-authored DATA resolved to a UID with no retrieval metadata visible under the placer's lens (an advertised file that cannot be read); re-publish foreign content with `writeFile` instead. (2) The TypeScript graph builder's hardlink short-circuit now honors `overviewSystemTagDef`: the `system` TAG is emitted in a layer strictly before the placement PIN (same no-untagged-flash ordering as normal writes) instead of being silently dropped, which left a hardlinked Overview visible in safety-filtered directory listings.
- 5390383: Two symmetry completions: (1) the EFSIndexer legs get the last missing send split — a code-less transport loss during `index`/`indexRevocation` now throws the new `IndexSendUnknown` (no hash exists; may still mine; `efs.index(uid)` is the safe idempotent reconcile), the redirect wrappers thread it onto `IndexingIncomplete.indexBroadcastUnknown` with an honest message instead of claiming the leg never broadcast, and the partial receipt counts the signed prompt (the wallet signed before the transport dropped). Refusal responses stay classified. (2) Solidity `setPropertyAt` validates the reused key-anchor before binding: it must be an ANCHOR in the PROPERTY bucket (`NotPropertyKeyAnchor` otherwise) — a PROPERTY bound at a file/folder anchor confirmed UIDs the canonical `resolveAnchor(dataUID, key, PROPERTY)` lookup never reaches, matching the TS reuse path's checks.
- cf15969: The readability invariant closes out across write entry points: (1) `buildFileWriteGraph` rejects a byte plan with an empty mirror set — the exported builder could mint a fully-confirmed file whose every `read()` fails `AllMirrorsFailedError` (the orchestrated `fs.write` paths already auto-store or reject). (2) Solidity `writeFile` reverts the new `EmptyMirrorSet` before anything mints when `w.mirrors` is empty (the docs previously said "may be empty"). (3) `redirects.set` gates DIRECT symlink→DATA links: path resolution reports the symlink author as `resolvedBy` and reads scope retrieval metadata to that address, so a symlink at a DATA whose mirrors live under someone else resolved but could never be read — the author must have their own active mirror on the target (or symlink to the file's ANCHOR, where the walk uses the placement winner's metadata); symlink→ANCHOR and sameAs/supersededBy edges are unaffected.
- f5c3db4: fix: fail closed on missing contentHash in value helpers; declare EAS dep for Hardhat; Solidity fmt

  - **`@efs/sdk` — `no-claim` is now fail-closed in the bare-value helpers.** `readText`/
    `readBytes`/`readJson` with default verification on a file that has NO `contentHash` claim
    previously returned the unverifiable bytes (verification `no-claim` was treated as success).
    They now throw the new `MissingContentHash` when verification was requested — a bare value
    has no status field to warn the caller. `{ verify: false }` opts out (then `no-claim` is
    fine), and `read()` still reports `verification:'no-claim'` without throwing.
  - **`@efs/solidity` — declare `@ethereum-attestation-service/eas-contracts@1.7.1` as a
    dependency** so Hardhat consumers resolve the EAS imports from `node_modules` (Hardhat reads
    the consuming project's `node_modules`, not this package's Foundry `remappings.txt`). Foundry
    still uses the shipped vendored copy via remapping. README corrected accordingly.
  - **`@efs/solidity` — fix `forge fmt` formatting** of `_efsPlaceExisting` (the failing
    Solidity CI check).

- 0bd625c: Two fixes from review:

  - **`@efs/solidity` `EFSLib.placeExisting` / `EFSWriter._efsPlaceExisting` gain an
    `existingFileAnchorUID` reuse overload.** The 5-arg/4-arg forms always mint the
    `(parent, name, DATA)` file-ANCHOR, so re-pointing an EXISTING path reverted on the
    permanent duplicate anchor (or filed a non-canonical anchor the read path never finds).
    The new 6-arg/5-arg overload reuses a pre-resolved anchor and emits only the
    cardinality-1 placement PIN (supersede-in-place) — mirroring `writeFile`'s
    `existingFileAnchorUID` and the TypeScript hardlink branch. Resolve the slot first via
    `EFSReader.resolveAnchor(parent, name, schemas.data)` (zero ⇒ new path → mints).

  - **`efs.fs.list(path, { limit })` now rejects a fractional/NaN/Infinity default limit**
    with the typed `InvalidDirectoryQuery` at construction (via `validateDirectoryQuery`)
    instead of throwing a raw `RangeError` at `BigInt(pageSize)` on the first page. Aligns
    the constructor/default-limit guard with `byPage`/`toArray`.

- 7214646: fix: paginate props.list; gate edge writes with WalletRequired; abort between on-chain deploys; doc bare contentHash

  - **`@efs/sdk` — `props.list` pagination.** It hard-coded one page (start 0, size 256) and
    ignored the cursor, so a DATA with >256 property key-anchors silently returned only the
    first page. It now loops until the cursor is exhausted, returning every property.
  - **`@efs/sdk` — edge-write wallet gate.** On a read-only client the graph/props/mirrors/
    redirects/lists write methods exist at runtime (the type hides them) and reached
    `edgeSubmitContext`, where the absent wallet threw a raw `TypeError`. It now throws
    `WalletRequired` first, matching `fs.write`/`eas`.
  - **`@efs/sdk` — abort between on-chain deploys.** `storeOnchain` now takes the abort signal
    and checks it before each of its two irreversible deploys (chunk, then chunk-manager), so
    an abort after the chunk lands no longer still sends the manager tx.
  - **`@efs/solidity` — bare `contentHash` doc.** `FileWrite.reservedKeys` NatSpec instructed a
    `0x…`-prefixed `contentHash`; the read/verify path treats that as `malformed-claim`. It now
    documents the bare lowercase 64-hex ADR-0006 digest (no `0x`).

- 07a42e5: Three fixes: (1) `efs.props.list` pages `getAnchorsBySchema` against the raw `getChildCountBySchema` count — the old full-page-implies-more loop probed one window past an exact page-multiple (256/512/… property keys), which the indexer's slice helper reverts (`InvalidOffset`), failing the whole listing. (2) Transport UIDs are validated/canonicalized BEFORE they can gate paid storage: deployment `transports` maps are canonicalized at `resolveDeployment` alongside schemas, and the write path's transport resolver rejects a template-compatible-but-malformed `transportDefinition` (`'0x01'`, non-hex) up front — previously it sailed through both irreversible SSTORE2 deploys and only exploded at the MIRROR ABI-encode, leaving paid storage with no receipt. (3) Solidity placement funnels (`placeExisting` and `place`) now also require the target to BE a DATA attestation (`NotDataUID(uid, schema)`): a self-authored ANCHOR/PROPERTY UID passed the authorship gate but pinned into the wrong schema slot — an `EFSFileWritten` placement no SDK reader could see.
- 2b834be: The readability proof extends to the last two placement surfaces: (1) `efs.graph.pins.place` now requires at least one ACTIVE mirror authored by the connected account on the target DATA before submitting (its plan is `hardlink: false`, so the layered submitter's hardlink proof didn't cover it) — a bare or all-revoked-mirror DATA refuses with guidance instead of confirming a placement whose every `read()` fails `AllMirrorsFailedError`. (2) Solidity `placeExisting` and `place` take the indexer (the thin `IEFSIndexerWrite` interface gains the two referencing-read getters) and revert the new `NoActiveMirror(dataUID, author)` unless the placer has an active MIRROR on the target — ownership proves who minted the DATA, not that the hardlink shortcut has metadata to reuse. Both scans walk raw-count-bounded filtered windows with first-hit exit (one count read plus one window in the healthy case).
- f7e400f: Three closures: (1) `buildRedirectPlan` stamps symlink plans with `symlinkTargetUID`, and the layered boundary re-runs the direct-DATA readability proof — the exported builder + `submitEdgePlan` pair could previously author the unreadable symlink the namespace verb refuses. (2) Solidity `setRedirect` applies the same gate: a `symlink` whose target attests as DATA requires the author's own active mirror (`NoActiveMirror`) before the atomic attest+index; ANCHOR targets are unaffected. (3) The exported `resolveTransport` now applies `DEFAULT_MAX_BYTES` when `maxBytes` is omitted — a direct caller's untrusted `data:` URI could previously materialize an arbitrarily large payload since `resolveData`'s cap checks were all conditional; only `fetchVerified` callers got the 50 MB default.
- 9290bb1: feat(solidity): REDIRECT (alias) read resolution + write wrapper (ADR-0050)

  `EFSReader` gains `redirectTarget` (lens-scoped authoritative active-redirect
  read), `resolveWithRedirects` (follow a caller-supplied redirect chain to its
  terminal target with cycle detection and a bounded max-hop cap — never an
  unbounded loop), and `followKind`. `EFSLib`/`EFSWriter` gain `setRedirect`
  (cardinality-N edge; `refUID` = source, `data = (target, kind)`, revocable),
  plus the `redirect` field on `SchemaUIDs` and the frozen `REDIRECT_KIND_*`
  constants. On-chain resolvers do not store or follow redirects (the reverse
  fan-in is off-chain by design), so a pure on-chain reader is fed candidate
  redirect UIDs and authoritatively decodes/guards/follows them. Cycle handling
  fail-closes (reverts) rather than computing ADR-0050's lowest-UID-in-SCC
  canonical node, which needs the full graph.

- 788a6e3: The Solidity `contentType` check now caps each of `type` and `subtype` at 127 characters, matching RFC 6838 §4.2 and the TypeScript validator's `restricted-name` grammar. The previous check bounded only the total length at 255 bytes, so a value like 128 `a` characters followed by `/x` was persisted by the Solidity write path while every other public write door in the SDK rejects it as a non-IANA media type. The two validators are hand-mirrored across languages and cannot share code, so they need comparing clause by clause rather than in spirit.
- 37badc4: The Solidity `contentType` check now accepts optional whitespace around media-type parameters, and rejects a dangling `;`.

  Diffing the Solidity validator against the TypeScript one clause by clause — rather than comparing them in spirit — surfaced three further divergences beyond the per-name length cap. Two of them **rejected valid values**, which is the worse direction: `text/plain ; charset=utf-8` and its HTAB variant are legal (RFC 9110 permits OWS around the `;`) and the TypeScript rule accepts them, but the Solidity path reverted the write. Optional whitespace is now trimmed off the name portion before the restricted-name check, and HTAB is permitted inside the parameter section — CR, LF, NUL and every other control character stay blocked, which is the property that matters for a value served as a `Content-Type` header. Separately, `text/plain;` with no parameter after the semicolon is now rejected, matching the TypeScript grammar.

  The two validators still differ on parameter _content_ (`text/plain; ~~~garbage~~~` is accepted on-chain, rejected in TypeScript) — that remains the deliberate bounded-subset trade-off, since full RFC 9110 parameter parsing would cost the caller gas on every write.

- 98e1a87: `@efs/solidity`'s redirect follower now matches the ratified resolution spec (specs/09 / ADR-0067), keeping the two published SDKs identity-consistent: `EFSReader.followKind` follows ONLY `symlink` (2) — `sameAs`/`supersededBy` are non-followed terminals (canonicalization and version history are separate, deliberate operations; an exact DATA identity never silently advances) — and `resolveWithRedirects`' `maxHops == 0` default is the ratified `D_MAX = 16` (was 8), hard ceiling 32. `@efs/sdk`: the redirect-lifecycle receipt wait (`set`'s index leg, `remove`'s revoke sequencing) re-asserts the LIVE provider chain immediately before waiting, so a post-broadcast chain switch fails closed (`WrongChain`) instead of polling another chain — where a landed index could read as a false `IndexingIncomplete` or a landed revoke could abort before its required `indexRevocation` leg.
- dfe075b: `EFSLib.setRedirect` now completes the REDIRECT indexing lifecycle ATOMICALLY: it takes the EFSIndexer (thin new `IEFSIndexerWrite` interface) and calls `index(redirectUID)` in the same transaction — `AliasResolver` never populates the referencing index that every SDK discovery read queries, so the old attest-only form produced redirects invisible to `redirects.get/list`, canonicalization, history, and symlink following until someone manually repaired them. The new `removeRedirect` helper does the second leg the same way (revoke + same-tx `indexRevocation` — a bare `eas.revoke()` leaves the redirect being served by filtered reads), and `EFSWriter` gains `_efsRemoveRedirect` while `_efsSetRedirect` takes the indexer. Because both legs run in one transaction, the partial "attested but undiscoverable" state the two-transaction TypeScript path must model cannot exist for contract writers.
- 1856e91: The Solidity write path now enforces the reserved-key value contract, and URI redaction survives leading whitespace.

  `EFSLib` is a separate public write path from the TypeScript SDK, and it stored reserved property values verbatim — so `{key: "contentHash", value: "0xdeadbeef"}` produced a fully successful write whose file then failed every default TypeScript read with `malformed-claim`, mirror bytes intact. `writeFile`'s reserved-key loop, `setProperty` and `setPropertyAt` now all validate through one `_assertReservedValue`, reverting with `InvalidReservedValue`. `contentHash` and `size` are checked against their exact canonical forms; `contentType` gets a deliberately bounded structural check (shape, RFC 6838 restricted-name characters so media ranges are rejected, a 255-byte ceiling, and printable-ASCII-only parameters so CR/LF cannot reach a served header) rather than the full RFC 9110 grammar, because on-chain string parsing costs the caller gas on every write. Non-reserved keys stay unconstrained.

  Separately, `summarizeUri` now normalizes leading and trailing whitespace before deciding what to redact. Both its `data:` and userinfo tests are anchored, so a single leading space caused a `" data:…"` locator to print 200 characters of its inline payload, and a whitespace-prefixed credential URL to print its password. This matters on the read side in particular: `fetchVerified` can be called directly, and the chain is append-only, so legacy or foreign mirrors carry whatever they were minted with.

- dd1a387: fix(solidity): ship the vendored EAS interfaces + remappings.txt in the npm tarball, and fix the README quickstart

  The `files` whitelist shipped only `src/**/*.sol`, so a consumer of the published
  package hit an import-resolution error: `EFSLib.sol` imports
  `@ethereum-attestation-service/eas-contracts/...`, whose vendored source under
  `vendor/` was excluded from the tarball. Now ship `vendor/**/*.sol` + `remappings.txt`
  so the package compiles standalone (consumers with their own eas-contracts can
  override the remapping — the vendored sources are byte-identical to 1.7.1).

  The README quickstart called a removed `_efsPinFile(path, dataUID)` and omitted the
  `IEAS` constructor arg; rewritten to the current `EFSWriter` API (`_efsPlace`, the
  `(IEAS eas)` constructor) with the correct Foundry/Hardhat remappings.

- ebe5f97: Fix three review findings around list materialization caps and the Solidity property
  update path:

  - **`efs.lists.entries(uid).toArray({ limit })` now validates the limit** with the same
    finite-positive-integer guard the constructor and `byPage` use. A fractional limit
    (`1.5`) used to over-collect (the `>= limit` break fired one entry late) and `Infinity`
    paged until the list was exhausted, defeating the mandatory materialization cap.

  - **`efs.fs.list(path).toArray({ limit })` now rejects non-finite/non-positive/non-integer
    limits** before paging. Previously `Infinity` made `remaining` infinite and
    `Math.min(defaultLimit, remaining)` collapsed to a normal page size, silently
    materializing the entire directory despite `toArray` being documented as requiring a
    bounded cap.

  - **`@efs/solidity` `EFSWriter` gains `_efsSetPropertyAt`** for property _updates_.
    `_efsSetProperty` always mints a fresh key-ANCHOR, so calling it twice for the same
    `(dataUID, keyName)` reverts on the permanent duplicate anchor rather than superseding.
    The new wrapper exposes `EFSLib.setPropertyAt` (mints only the PROPERTY + binding-PIN
    against a pre-resolved key-ANCHOR, cardinality-1 supersede); the `_efsSetProperty`
    docstring now states it is the first-set/create form and points updates at the new
    helper (mirroring the TypeScript `props.set`, which resolves and reuses the anchor).

- 3eefe9f: fix: web3 transport resolves the `/transports/onchain` anchor; Solidity writeFile overwrite

  - **`@efs/sdk` (P1)** — the on-chain transport fallback for a default `web3://` write now resolves the
    `/transports/onchain` anchor (the scheme key is `web3`, but the bootstrap anchor is named `onchain`
    — per the deploy fixture). It previously resolved `/transports/web3`, which doesn't exist, so a
    default no-mirror write on a deployment that seeded the real anchor but not the inline `transports`
    map (the built-in Sepolia entry) still threw `MissingTransport`. Same fix applied to `efs.mirrors.add`.
  - **`@efs/solidity` (P2)** — `EFSLib.FileWrite` gains an optional `existingFileAnchorUID`: when set,
    `writeFile` reuses that permanent file-ANCHOR instead of re-minting it (which reverts on the duplicate
    slot), so a contract can OVERWRITE a path in place (the new placement PIN supersedes the prior one).
    `bytes32(0)` keeps the mint-fresh behavior for a new file.

- 5bd8f68: fix: resolve web3 transport on-chain for default writes; round-trip empty property values; clamp Solidity redirect hops

  - **`@efs/sdk` (P1) — default `web3://` write works on Sepolia.** `transportDefinitionFor` now
    falls back to resolving the `/transports/<scheme>` anchor ON-CHAIN when the deployment's
    `transports` map lacks it (matching `efs.mirrors.add`). The built-in Sepolia entry has no
    `transports` map, so a default no-mirror `fs.write` previously threw `MissingTransport`; it now
    resolves `/transports/web3` on-chain.
  - **`@efs/sdk` (P2) — empty property values round-trip.** `decodePropertyValue` no longer coerces a
    decoded empty string to `undefined`, so `efs.props.set(uid, key, '')` is readable by
    `props.get`/`props.list` (absence is the missing property/binding UID, not an empty value).
  - **`@efs/solidity` (P2) — bounded redirect hops.** `EFSReader.resolveWithRedirects` clamps `maxHops`
    to the 32-hop ceiling, so a hostile value can't overflow `cap + 1` or force a huge `visited`
    allocation.

- 2e08e15: fix: normalize `ar://` write mirrors, honor `WriteOptions.signal`, correct the Foundry remapping

  - **`@efs/sdk`** — `fs.write` now normalizes an `ar://` mirror's scheme to the canonical
    `arweave` transport key (matching the read resolver and `mirrors.add`), so Arweave writes
    no longer throw `MissingTransport` unless a `transportDefinition` is supplied manually.
  - **`@efs/sdk`** — `WriteOptions.signal` is now honored: the write checks the `AbortSignal`
    before the first irreversible step (on-chain storage) and before each layer's `multiAttest`,
    so an already-aborted (or mid-write aborted) signal stops further irreversible transactions.
    It is never checked mid-flight — a broadcast tx can't be unsent — so aborting between layers
    leaves a partial write, the same boundary as a revert.
  - **`@efs/solidity`** — fix the README Foundry remapping (`@efs/solidity/=node_modules/@efs/solidity/`,
    not `.../src/`) so the documented `@efs/solidity/src/EFSWriter.sol` import resolves.

- db67484: `EFSLib.writeFile` validates a reused `existingFileAnchorUID` BEFORE minting the DATA graph: a PROPERTY/DATA/nonexistent reused UID now reverts `NotAnchorUID` up front — previously the full write confirmed (and `_efsWriteFile` emitted `EFSFileWritten`) for a placement path resolution can never discover, with the whole attestation graph already minted. This closes the last placement funnel missing the definition gate.
