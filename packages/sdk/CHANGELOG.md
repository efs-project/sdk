# @efs/sdk

## 0.1.0

### Minor Changes

- c3452c5: The EFS **v1 profile boundary** (ADR-0019, the Aug-7 review's R1–R6): the implementation is now EXPLICITLY the v1 profile, so a future v2 (a carrier replacement — EAS dropped, logical IDs, 5 kinds) lands beside it instead of silently reinterpreting persisted v1 state. `createEfsV1Client()` is the canonical factory (`createEfsClient` stays as a deprecated one-cycle alias — same function); the client carries `readonly profile: 'efs/v1'` (`EFS_PROFILE_V1`), with `EfsV1Client`/`EfsV1ReadClient`/`EfsV1ClientConfig` aliases and the `EfsV1ProtocolSurface` type naming the EAS-scoped namespaces ("stable verbs, versioned result envelopes"). Persisted artifacts are stamped: `DataRef`, `WriteReceipt`, and `FileWriteGraph` gain required `profile: 'efs/v1'` (a v1 EAS UID and a v2 logical ID are both bytes32 — only the stamp tells them apart). NEW durable serializers in `artifacts.ts` (`serializeDataRef`/`parseDataRef`, `serializeWriteReceipt`/`parseWriteReceipt`): versioned envelopes, lossless tagged bigints, fail-closed `UnsupportedArtifact`/`MalformedArtifact` (new errors/codes), opaque-extension preservation — and `efs.toJSON` is now documented as logging-only (its output is deliberately rejected by the parsers). BREAKING renames vs the unreleased scaffold: `WriteOptions.lens` → **`author`** (a lens is reader policy; `author` is the vocabulary v2 keeps), and `WriteReceipt` gains required `roles: WriteRoles { author, signer, payer, submitter? }` — one EOA fills every role on Tier-1 (output-only), with `SubmitterContext.roles` as the AA/relay divergence seam. `@efs/solidity`: sources move to **`src/v1/`** and the exports map narrows to `./src/v1/*.sol` — the profile is explicit in every import path while symbols stay clean (`EFSLib`, not `EFSLibV1`).
- 66a010a: Foundational read-architecture scaffolding (ADR-0014, ADR-0015) — additive, no behavior
  change yet. Reserves the seams that future runtimes plug into so offline/indexer/Ring-3
  support lands additively rather than as a breaking retrofit:

  - **`ReadSource`** interface + `ReadSourceCapabilities` — the thin, generic seam reads will
    funnel through (decouples reads from a live chain-bound viem client). `ViemReadSource` is
    the live adapter (chain carried as DATA); `SnapshotReadSource` (offline) and
    `IndexerReadSource` are documented stubs with honest capabilities that throw `NotImplemented`
    on read.
  - **`TrustDescriptor`** — the read-provenance shape: a discriminated union on `freshness`
    (`'current'` = chain-head; `'as-of'` = bounded-stale, carrying an `asOf` timestamp + the
    observed `ReadBasis`; `'stale'` = content-only cache where on-chain existence/revocation
    are UNKNOWN), each variant carrying a `source` drawn from the `ReadSourceCapabilities.kind`
    vocabulary. Now a REQUIRED `trust` field on the rich read results (`EfsFile`/`FileInfo`/
    `ReadResult`) — see the trust-provenance changeset.
  - **Reserved client-config slots** `fetch` and `verifier` (a `SignatureVerifier` seam for
    non-ECDSA / Ring-3 brokered crypto). Not yet honored — passing either throws `NotImplemented`
    (an explicit reserved signal, never a silent no-op).

  The `ReadContext` rename, wiring `ViemReadSource` into the read path, and chainless
  (`SourceConfig`) construction are the remaining behavioral phases (ADR-0014's amended
  phasing); the `trust` stamping has landed (ADR-0015 Accepted).

- f5bd087: Read-trust provenance is LIVE (ADR-0015 Accepted) and the six standing review blockers are closed. (1) `trust: TrustDescriptor` is now a REQUIRED field on `EfsFile`/`FileInfo`/`ReadResult` (BREAKING shape change, taken pre-1.0 as the ADR planned) — every read today stamps the constant `{ freshness: 'current', source: 'live' }` (`LIVE_TRUST`, exported); the fail-closed sugar (`readText`/`readBytes`/`readJson`) gains the `requireTrust` floor (`'as-of'` default / `'current'` / `'any'`) enforced by the new `assertTrust` helper + `StaleTrust` error — the gate cannot fire today, and exists precisely so future offline/indexer sources cannot weaken the sugar's contract. (2) The provenance story gains its evidence layer (ADR-0014/0015 amended pre-acceptance): `ReadSourceCapabilities.authoritative: boolean` is REPLACED by the objective `state: 'head' | 'lagging' | 'pinned'` + `pinnedBasis`, with the new result-carried `ReadBasis` type (chainId/block/hash/finality/asOf) — a live RPC is never asserted as proof of canonical state; the endpoint is the stated residual trust. (3) `snapshotReadSource` stops lying: no `getCode` stub answering `undefined` (an absent method is the honest no-capability signal), `supportsGetCode`/`supportsEns` hard `false` until the lookup slice lands, capture provenance moved to `pinnedBasis`. (4) `schemaRecordFor` re-throws a systemic `WrongChain` during depth-2 schema hydration (`expand:['attestations.schema']`/`withSchema`) instead of fulfilling with a silently-missing `schemaRecord` — per-schema degradation (absent/transient) still returns `undefined`. (5) ADR-0014's phasing is amended to match the shipped reality: chainless (`SourceConfig`) construction lands with the ReadSource behavioral slice, so the construction-time chainless rejection stays in force and documented. (6) The raw escape-hatch docs/release notes no longer claim chain drift is re-resolved — raw instances are construction-chain-bound and fail closed with `WrongChain`; a `deployments` override (a different thing) is reflected. The earlier scaffolding changeset's stale flat `TrustDescriptor` description is corrected to the shipped freshness union.

### Patch Changes

- a03af0c: Two correctness fixes: (1) ambiguous JSON-RPC send errors are no longer treated as proof that nothing was broadcast. `RpcError` is removed from the definite-refusal set — `-32000: already known`, `nonce too low`, and `replacement transaction underpriced` all mean the transaction (or a rival for its nonce) is already in the mempool and may mine, so they now surface as the UNKNOWN-send states (`WriteSendUnknownError` / `EasSendUnknown` / `OnchainSendUnknown` / `IndexSendUnknown`) instead of "not sent". Only wallet/provider refusal codes, decoded reverts, and the SDK's own pre-send guards remain definite. (2) List pagination derives its attester selection per request instead of mutating shared primed state — an attester-bound cursor on one `byPage()` call no longer moves a later unbound `byPage()`, `toArray()`, or iteration off the first-ranked candidate on the same `EfsList` handle.
- 6273175: Concrete `existingAncestorTagUIDs` are now validated before anything broadcasts: the builder shape-checks them (nonzero bytes32, both content kinds) and stamps them on the plan, and the submission boundary verifies each is an ANCHOR attestation. Their visibility TAGs sit in the LAST layer, so a well-shaped but nonexistent or non-anchor UID previously reverted only after the DATA, file anchor, metadata and placement had mined — a paid, half-applied write.
- 1a7d14e: The placement gates now validate BOTH sides of the PIN: `efs.graph.pins.place` and Solidity `EFSLib.place` verify the definition is an ANCHOR attestation (`NotAnchorUID` on the Solidity side, a typed `InvalidArgument` on the TS side) — EdgeResolver accepts any existing attestation as a PIN definition, but path resolution discovers placements by resolving an ANCHOR and only then reading its PIN slot, so a PROPERTY/DATA (or nonexistent) definition confirmed a placement no reader could ever find. The TS check batches into the same `Promise.all` as the target read (multicall-coalesced).
- 846835e: The file-ANCHOR now mints in the SAME `multiAttest` layer as DATA (it depends only on the already-resolved parent — concrete, or the last `mkdir -p` folder from an earlier layer). Two `fs.write` calls racing for the same empty path both probe no-anchor; previously the loser's DATA layer mined before its anchor layer reverted `DuplicateFileName`, leaving paid storage plus an orphaned DATA graph with no file written. With the anchor in DATA's layer the slot collision rolls the whole layer back atomically — the loser lands nothing on the EAS side, its storage deploys ride the partial error's `storage` for reuse, and the retry resolves the winner's anchor into the overwrite path. (The Solidity `writeFile` is single-transaction and was already atomic.)
- 43d5cdb: The declared `attester` must be the account that actually signs. `submitEdgePlan`, `submitEdgePlanWithUID`, and `Tier1Submitter.submit` now reject a mismatch before broadcasting — previously a direct caller of these exported seams could pass an unrelated address, and the confirmed receipt would stamp it into `roles.author`/`signer`/`payer` (and, on the submitter seam, `DataRef.resolvedBy`), attributing on-chain attestations to an address that never authored them and making later reads through that ref resolve under the wrong lens. Rejected rather than silently corrected: a divergent attester means the caller's model of who is writing is wrong. Relayer/paymaster role divergence still rides `roles`, which is unaffected.
- 4bbdbbf: DX polish (review P3): a bigint-safe JSON serializer + an `AnchorUID` brand.

  - **`efs.toJSON(value, space?)` + the exported `jsonReplacer`.** EFS result DTOs carry `bigint`s — `FileInfo.size`, `ListConfig.maxEntries`, the TAG weight reads, `WriteEstimate.gas`, the EAS `Attestation` time fields — and bare `JSON.stringify` THROWS on a bigint (`TypeError: Do not know how to serialize a BigInt`). That surprised devs the first time they logged a receipt, persisted a result, or handed a DTO across a serialization boundary (TanStack Query's cache, a Next.js Server→Client component prop, `res.json(...)`). `efs.toJSON` (and the lower-level `jsonReplacer`, a plain `JSON.stringify` replacer) render those bigints as decimal strings. Present on read-only clients too; pure + stateless. Documented round-trip caveat: serialization is lossy of the bigint TYPE — bigints come back as strings on `JSON.parse`, not bigints (there is no safe automatic reviver), so the consumer re-`BigInt(…)`s the fields it knows are numeric (same as viem/wagmi at the JSON boundary).

  - **`AnchorUID` brand.** A folder ANCHOR's UID is now branded distinctly from `DataUID` (review P3 / A11): `DirEntry`'s dir variant carries `anchorUID: AnchorUID`, its file variant carries `dataUID: DataUID`. Catches the wrong-UID-kind integration bug at the type level — passing a folder anchor where a file's DATA UID is expected. Both are `Hex` at runtime (zero cost); the distinction is type-only. `AnchorUID` is exported alongside `DataUID`.

  New exports: `toJSON`, `jsonReplacer`, `AnchorUID`. No runtime behavior change to existing verbs; no bundle-size-relevant code on the read/write hot paths.

- 1223ea1: Two follow-on corrections: (1) list-pagination cursors now BIND their offset to the attester whose listing they index (`<offset>:<attester>`): resuming re-aligns the selection to the bound attester (continuing that listing exactly — no skip, no duplicate — even when it is no longer the ranked leader), and a cursor whose attester left the candidate set is void, restarting the ranked walk at offset 0 instead of silently applying a foreign offset to the new winner. Legacy bare-numeric cursors still parse and apply to the current selection. (2) `redirects.remove` now threads `IndexSendUnknown` onto `IndexingIncomplete.indexBroadcastUnknown` like `set` does — the previous wave's edit script had crashed before applying the remove-branch change, so a lost-response `indexRevocation` send reported `indexBroadcastUnknown: false`, a provably incorrect outcome for the documented recovery field.
- 414fa0b: The placement-gate matrix completes: (1) the DATA-bucket check is now UNCONDITIONAL in the TS gates — the layered boundary and `pins.place` decode every placement anchor's `(name, forSchema)` payload and refuse anchors outside the DATA file bucket even on standalone plans with no requested slot (a generic-folder or PROPERTY-key ANCHOR passed the schema check but file resolution only discovers DATA-bucket terminals). (2) Solidity `writeFile` and the six-argument `placeExisting` bind reused anchors to the requested `(parent, fileName, DATA)` slot via the shared `_requireAnchorNamesSlot` (reverting the new `AnchorSlotMismatch`), and the standalone `place` enforces the DATA bucket (`NotFileBucketAnchor`) — a valid ANCHOR from another slot previously let the transaction and `EFSFileWritten` confirm while a different path was overwritten or nothing discoverable was placed.
- 90c1ac2: The exported graph builder gains the full byte-plan preflight: (1) every mirror URI is validated (`validateMirrorUri` — blank/oversized URIs previously encoded fine and reverted at the layer-2 MirrorResolver AFTER layer 1 mined, leaving a paid partial graph); (2) `contentHash` and `size` are verified against the supplied bytes before any layer is constructed — the `ContentHash` brand checks format only, so a stale hash from changed bytes persisted permanently and made every fail-closed read (`readText` etc.) reject forever, while a wrong size attested false metadata. `hashContent` is synchronous, so the builder stays pure and sync; the orchestrated `fs.write` path derives both values itself and is unaffected.
- 002b2d0: Anchor segments are now canonically encoded per contracts specs/02 (NFC + uppercase percent-encoding of the reserved byte set), fixing the P1 where `fs.write('/Q&A: Episode 5/file.txt')` reverted at the ANCHOR layer after storage deployed and a decomposed-Unicode segment silently minted a different permanent slot. One codec module (`names/segment.ts`, new exports `encodeName`/`decodeName`/`isCanonicalName`/`asCanonicalName`/`CanonicalName`/`InvalidAnchorNameError`) mirrors `EFSIndexer._isValidAnchorName` byte-for-byte — including the over-escape rejection the contract enforces but the spec prose omits (flagged upstream). Public `fs.*` path strings and `props`/`fields` keys are HUMAN; encoding happens once at the resolution choke points (`splitPathToCanonical`, `resolvePathToAnchor`, `resolveOrPlanParents`, `readReservedProperty`, `props.set`), validated BEFORE any chain read or storage deploy. A raw string is never sniffed as canonical (provably ambiguous: `100%25` is both a legal human name and a legal canonical form) — the `CanonicalName` brand on `ParentPlan`/`FileWriteGraphInput`/`buildPropertyPlan` is the boundary, with a dev-guard in `buildFileWriteGraph`. Chain-out names decode back to human: `DirEntry.name` and `props.list()` keys now return the strings you wrote (fail-soft verbatim for non-canonical foreign data). BREAKING vs the unreleased scaffold: a pre-encoded segment passed as a path is now treated as human and double-encodes — callers holding canonical forms must `decodeName` first (or use the exported codec); `ParentPlan.fileName`/`missingSegments` are `CanonicalName`. New error code `InvalidAnchorName`. Spec vectors (`Q%26A%3A%20Episode%205`, composed/decomposed `é`, literal `%`, the full reserved-byte table) imported as tests.
- 8256673: Three write-time validation fixes on values that become authoritative.

  Arweave transaction ids must now be canonical base64url. 43 base64url characters carry 258 bits but the id is a 32-byte hash, so the final character's low two bits are padding and must be zero — the length-and-alphabet screen accepted a non-canonical spelling that strict base64url and Arweave parsers reject, and `fs.write` could confirm it as a file's only mirror.

  `contentType` no longer accepts media RANGES. Both halves used the HTTP token grammar, which permits the wildcard character, so `text/` + wildcard passed — that is what a client sends in `Accept`, not what a file is, and stored as authoritative metadata it even reads as displayable text because `fs.overview()` keys on the `text/` prefix. Type and subtype now use the RFC 6838 restricted-name grammar; parameter names and values keep the token grammar.

  The reserved `size` property is now validated on the shared builder alongside `contentType` and `contentHash`. A malformed value does not degrade gracefully as it first appears: every reader's `parseSize` returns `undefined`, and in `reads/overview.ts` that `undefined` skips the documented pre-fetch `too-large` short-circuit entirely, so the overview attempts a fetch and fails at the render cap instead of returning `{kind: 'too-large'}` without touching the network. `fs.info()` simply omits the size. The canonical non-negative decimal form that file writes emit is required.

- ebcd3a2: Two boundary-validation fixes: (1) `resolveDeployment` now canonicalizes every schema UID on the returned record to `0x` + 64 lowercase hex (memoized copy; the source record is never mutated) and rejects values it cannot consume with a typed error — verification was already value-tolerant of how a custom record writes a UID (uppercase, leading-zero-shortened), but the non-canonical form then broke strict-equality consumers (the symlink walk reported valid redirect targets as dangling) and `bytes32` ABI encoding. (2) `resolveLens` validates every address at the common lens boundary with `isAddress` — a malformed template-compatible literal (`'0x1234'`) or a custom lens's bad output now fails immediately with a typed error instead of surfacing later as a generic ABI/RPC read failure.
- 06527b6: Two strictness fixes on values that reach the chain irreversibly.

  CID varints must now be minimally encoded. `unsigned-varint` requires the shortest form, but the decoder returned the numeric value without checking, so `81 00` and `01` both read as version 1 — meaning a valid CID with a redundant byte spliced in cleared the entire write preflight and could be minted as a file's only mirror, while strict CID parsers and gateways reject the locator outright.

  `contentType` parameters are now validated against the real RFC 9110 grammar. The quoted-value branch was `"[^"]*"`, which accepts raw control characters, and the separator used `\s*`, which admits CR and LF. A value like `text/plain; note="a<CR><LF>b"` therefore passed and was persisted as the authoritative PROPERTY and as the ERC-5219 store's reported MIME — a CRLF that any gateway echoing the header would emit verbatim. The quoted branch now spells out `qdtext` and `quoted-pair`, and whitespace is restricted to HTTP `OWS` (SP/HTAB). Legitimate quoted parameters, including escaped quotes, are unaffected.

- 9a5a6bf: `efs.account.capabilities()` now keys the account probe by the LIVE provider chain
  instead of the construction-time `publicClient.chain.id`. The `getCode` classification
  and EIP-5792 `getCapabilities` already land on the provider's current chain, so a mutable
  EIP-1193 provider that switched networks after the client was built could mix new-chain
  bytecode/capabilities into an old-chain cache slot and return the wrong `kind`/gasless
  status. Querying `publicClient.getChainId()` for the cache key keeps detection consistent
  with the chain the reads actually hit — the last live-chain gap, matching the read and
  write paths.
- eb107fd: Two review fixes: (1) `efs.account.capabilities()` accepts `{ refresh: true }` — the client-level invalidation lever for the capability-profile cache. The probed inputs are mutable on-chain state (a counterfactual smart-account deploy or an EIP-7702 delegation added/removed changes the account's code without changing the cache key), and provider-form callers cannot reach the internally-created wallet object that scopes the cache; the option evicts the live-chain cache entry and re-probes. (2) `parseWriteReceipt` now REBUILDS the nested `data` ref (validated fields + `__brand: 'DataRef'` + profile) instead of spreading the payload through — an external artifact could omit or forge the brand and violate the branded `WriteReceipt.data: DataRef` contract; the construction is shared with `parseDataRef` via one helper.
- b44aa52: The SSTORE2 chunk deploy gets the same send-outcome honesty as the manager leg and the layered submitter: a code-less transport failure during the chunk send (connection drop after the request may have reached the node) now throws the new `OnchainSendUnknown` — broadcast state unknown, the deploy may still mine and bill gas, no hash to reconcile by — instead of an ordinary classified error that invited a `fs.write` retry paying for duplicate storage. A refusal response (wallet/node error code, decoded revert) still propagates as the classified error, where a retry is clean.
- 75ee8e0: The default `fs.write(path, bytes)` on-chain (SSTORE2) storage path now routes its
  wallet/RPC calls through the same `classifyError` funnel the submitter uses. A wallet
  rejection or RPC failure during the chunk deploy, manager deploy, or receipt wait now
  surfaces as the documented EFS error tree (`UserRejected` / `RpcError` / typed write
  errors) instead of a raw viem/provider error — so callers handling the EFS error tree no
  longer miss the common quickstart write path. Abort (`signal`) still propagates as the
  caller's `AbortError` (the pre-send checks stay outside the funnel), and typed errors like
  `MultiChunkUnsupported` pass through unchanged (the classifier is idempotent).
- b4f4a1a: Reused concrete file-ANCHORs are now validated before broadcast: (1) the builder stamps plans with `anchorSchemaUID` + `existingAnchorUID` when an overwrite/relink reuses a concrete anchor, and `submitLayeredTier1` verifies the reused definition IS an ANCHOR attestation (fail-closed on a missing stamp or a read-incapable context) — an arbitrary `existingFileAnchorUID` executed through the exported layered submitter previously skipped the anchor mint and could confirm a placement `fs.*` can never discover. (2) Solidity's six-argument `placeExisting` applies the same `NotAnchorUID` check to a nonzero reused anchor before attesting the PIN. For `fs.write` (which resolves the UID via `resolveAnchor` — an ANCHOR by construction) this is one extra defense-in-depth read per overwrite.
- 6ba6eb7: `contentHash` now conforms to the ratified v1 encoding (contracts specs/10, SDK ADR-0016 superseding ADR-0006). `hashContent` emits the canonical multibase-base16 multihash string — `f1220` + 64 lowercase sha2-256 hex chars (69 chars) — instead of a bare digest, and the `ContentHash` brand now means that canonical string. The read path gains an algorithm-aware accepted-form decoder (`decodeContentHash`, new export with `CONTENT_HASH_CODES`): `f`/base16 and `b`/base32 (RFC 4648 lowercase, no padding) forms of the two registered functions (`0x12` sha2-256 canonical, `0x1b` keccak-256 alternate) decode, and `verifyContent` compares at DIGEST level, so a base32 or keccak-alternate claim of matching content verifies `matches-author`. Bare digests (the old ADR-0006 form), `0x`-prefixed values, uppercase, and unregistered codes report `malformed-claim` — deliberately, with no bare-digest tolerance: no SDK-written durable data exists, and the only legacy Sepolia population (debug-UI `0x`-keccak values) already read `malformed-claim` before. The mirror engine's `statusFor` now delegates to `verifyContent` (one decode/verify implementation). `FileWriteGraphInput.contentHash` is typed as `ContentHash` so a non-canonical string cannot re-enter the non-revocable PROPERTY persistence path. specs/10 §7 conformance vectors imported as tests. `@efs/solidity`: `EFSLib.ReservedKey` doc updated to the canonical form (comment-only).
- 512878e: Close the two gaps left by the previous mirror fixes. The IPFS CID check no longer has an alphabet-only path: every accepted multibase (base2/8/10/16/32 families, base36, base58btc, base58flickr) is really decoded and the bytes face the same version/codec/multihash parse, so `ipfs://k0000000000` — well-formed base36, not a CID — is refused. And the Solidity SDK's `_requireActiveMirror` now scans the newest 500 raw slots like the TypeScript reader and `EFSRouter`, instead of the oldest 500: an active mirror stranded below the readable window no longer lets a placement through, and one past the 500th slot no longer blocks a readable DATA.
- bda186b: Deployment registry hardened (ADR-0018, review r3739110412 / contracts#43-#44). The Sepolia record now carries the 2026-06-23 HARDENED view trio (EFSRouter `0x44D5…c82c`, EFSFileView `0x76B1…76d3`, ListReader `0xCc18…58FC`) — the prior trio was copied from the stale `deployedContracts.ts`; record precedence is now the contracts repo's hardhat artifacts + `docs/CHAINS.md` (which agree), enforced by a new CI drift gate (`scripts/check-deployment-drift.mjs`) with three distinct failure modes including "upstream records conflict". New structural core/view split (`CORE_CONTRACT_KEYS`/`VIEW_CONTRACT_KEYS`, flat `EfsContracts` unchanged) + per-deployment `EfsViewRevision` pinning runtime codehashes from a live readback; `verifyDeployment` gains `assertViewRevision` (new export), which catches a stale-but-still-has-bytecode view address — the exact drift class the code-exists check could not see (only the router's bytes actually changed; honest limits documented). BREAKING vs the unreleased scaffold: the built-in DEVNET (26001993) entry is REMOVED — the live devnet runs fork-local addresses with different schema UIDs (probed 2026-08-07; the fork pin predates the freeze blocks, so the mirror-Sepolia design cannot currently hold), meaning the old entry could not serve a single successful call; `resolveDeployment(26001993)` now throws `DeploymentNotFound` with a devnet-specific hint (`DEVNET_CHAIN_ID` exported). A tripwire test pins that the SDK makes no WHITEOUT claims (contracts#44: availability is never inferred from an ABI existing); the SDK's manifest wishlist for contracts#43 is recorded in the ADR.
- 581ecce: Corrected the `WriteOptions.mirrors` documentation: each entry selects its own transport definition from its OWN URI scheme, not the first entry's. The implementation has resolved per-entry since mixed-scheme durability sets were supported, so a caller following the old contract could provision only the first scheme and then hit an unexpected `MissingTransport` on a later mirror. The doc now states the per-entry rule, that every scheme used needs a recorded anchor, and that an explicit `transportDefinition` overrides the lookup for all entries. Documentation only — no behavior change.
- 075ac9f: Add the standalone edge/value write primitives — TAG, PROPERTY, and PIN — the most-used protocol operations after file-write (review completeness P1-1). They reuse the exact attestation shapes the file-write DAG already encodes (`writes/graph.ts`) and route through the SAME Submitter seam as `fs.write`, so they are small, correct-by-construction, and tree-shakeable.

  - **`efs.graph.tags`** — the TAG edge. `add(target, definition, { weight?, targetSchema? })` authors one revocable `TAG(definition, refUID = target, weight)` (weight defaults to 1); `definition` may be a TAG-definition UID or a `/tags/<name>` label the SDK resolves via the indexer. `remove(tagUID)` revokes it (through `efs.eas.revoke`). Reads: `active(attester, target, definition)` over `getActiveTagWeight`, and `list(target, definition, { lens })` (one active-weight read per lens attester, cardinality-N so no first-wins truncation). One signature.
  - **`efs.props`** — the PROPERTY value. `set(dataUID, key, value)` emits the key-ANCHOR + free-floating PROPERTY + binding-PIN triple (the reserved-key builder generalized to an arbitrary key; the key-ANCHOR's `forSchema = PROPERTY_SCHEMA_UID` keying is preserved so the read resolves). `get(dataUID, key, { lens })` reuses the read engine's reserved/custom property reader; `list(dataUID, { lens })` enumerates the key-ANCHORs (`getAnchorsBySchemaAndAddressList`), decodes each name, and reads each value. Two signatures (the triple is a 2-layer DAG).
  - **`efs.graph.pins`** — the placement PIN. `place(anchor, dataUID)` emits a cardinality-1 `PIN(definition = anchor, refUID = dataUID)` that supersedes the prior active placement at that slot in O(1); `unplace(pinUID)` revokes it; `active(anchor, attester?)` reads `getActivePinTarget`. One signature.

  Mechanism: the writes build a minimal `FileWriteGraph`-shaped plan and submit through `submitLayeredTier1` (the mechanism-neutral core extracted from `submitWriteTier1`), returning a normalized `WriteReceipt` with an honest `signatureCount` (the layer count: 1 for TAG/PIN, 2 for the PROPERTY triple) and the Tier-1 `mechanism`/`gasless`/`reason` stamp. `WriteReceipt.contentHash` is now optional (absent on these content-less writes). The namespaces are type-gated like `fs.write` (present only on a write-capable client) and additive (new top-level `graph`/`props` namespaces). Bundle delta ~+0.5 kB gzip (23.7 kB, well under the 36 kB budget).

- 16bf2c9: Two read-path correctness fixes:

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

- 96a8bc5: Two fixes:

  - **`fs.write` rejects an empty/blank mirror URI per element.** Previously only an empty
    `mirrors: []` array was rejected; `mirrors: ['']` with an explicit `transportDefinition`
    bypassed the scheme check and mapped the empty URI into the MIRROR plan, so the L2 MIRROR
    batch reverted (MirrorResolver requires a non-empty URI) _after_ the L1 DATA attestation
    had landed — orphaning a partial write. Each supplied URI is now validated non-empty
    before any tx (`InvalidArgument`).
  - **`web3://` reads support raw single-SSTORE2 targets.** A `web3://` mirror that points
    directly at a raw SSTORE2 data contract (an older on-chain store, or one written by
    another client) has no `chunkCount()`. The SDK treated that probe failure as fatal,
    failing reads when such a mirror was the only one. It now mirrors the canonical router:
    on a failed `chunkCount()` it reads the target's own bytecode and strips the leading
    SSTORE2 STOP byte (`EFSRouter.sol` web3:// fallback — router parity, ADR-0013).

- 7ab8a54: Three review fixes: an explicitly empty `transports: []` allowlist is honored as "no transports allowed" (zero candidates → the read fails) instead of silently widening to every scheme — omitting the option remains the allow-all form; the chain-guarded read proxy re-checks the LIVE chain AFTER each `readContract`/`getCode` resolves, so a provider that switches between the pre-check and the actual call can no longer have its chain-B result accepted as chain-A data (the capability probe could cache wrong-chain bytecode; ordinary reads could return wrong-chain values); and caller CANCELLATION propagates as the abort itself — `fetchVerified` no longer converts an aborted signal into `AllMirrorsFailedError`, and the read path passes `AbortError` through the classify funnel raw, so UIs can distinguish "user cancelled" from "mirrors are down".
- d9b45c7: Two fixes: (1) `getEnsAddress` is now chain-guarded like `readContract`/`getCode` — the client holds one provider, so an ENS-backed lens resolved during provider drift produced an attester from another chain's registry while the guarded EFS reads ran on the deployment chain (false absence, or another lens's data). Both the read path and `efs.lenses.resolve` now resolve through the guarded client. The earlier "cross-chain by nature" exemption bought nothing with a single client — it only made resolution nondeterministic. (2) Mirror-URI preflight now runs the SDK's structural parser for schemes the SDK itself resolves: `ipfs://!` and friends previously minted a valid MIRROR (the chain has no scheme allowlist by design) that no read could ever resolve, leaving `AllMirrorsFailedError` on a confirmed file. Unknown/custom schemes pass through untouched, preserving the ADR-0056 escape hatch.
- e318ca6: Complete the SDK's escape hatches — `efs.raw.*`, `efs.eas.*`, and `efs.decode` — so a dev can always drop to the raw layer and back (review P1-4). The do-everything client is now de-risked: anything the typed verbs don't expose is reachable directly, typed, against the right address, with a typed round-trip back.

  - **`efs.raw.*` pre-wired contract instances.** viem `getContract` instances bound to the resolved deployment addresses + the vendored ABIs + the client: `raw.indexer`, `raw.router`, `raw.fileView`, `raw.edgeResolver`, `raw.mirrorResolver`, `raw.listReader`, `raw.aliasResolver`, `raw.eas`. Read methods (`.read.*`) are available always; write methods (`.write.*`) appear only when a wallet is present (viem's own getContract split mirrors the SDK's type-level write gate). Instances resolve the deployment lazily on access from the client's construction chain, so a missing deployment throws `DeploymentNotFound` at use, not at construct. They stay bound to that construction-chain deployment: if the provider later drifts to another chain, raw reads and writes fail closed with `WrongChain` rather than re-pointing at the new chain's deployment. `raw.deployment()` / `raw.verifyDeployment()` are unchanged.
  - **`efs.eas.*` raw EAS verbs.** Added `attest`, `multiAttest`, `revoke`, and `getAttestation` to the `eas` namespace (over the connected wallet/public client + the EAS address from the deployment), alongside the existing `encoder`/`computeUID`/`verifyUID`/`attestationsFor`. The write verbs require a wallet — gated at the type level (the read-only client's `eas` is `EfsEasReadNs`) with the `WalletRequired` runtime backstop — and route through `classifyError` (ADR-0007). `getAttestation` reads always and returns `undefined` for an absent (zero) record. Added a vendored `revoke(RevocationRequest)` ABI fragment to `easAbi` (exported as `revokeAbi`).
  - **`efs.decode`** — the round-trip bridge so dropping to raw isn't one-way. Given a raw EAS `Attestation` it decodes (sync, pure) into a discriminated result keyed by schema (`data`/`anchor`/`pin`/`tag`/`mirror`/`property`/`list`/`listEntry`/`redirect`) with named, typed fields, matching the attestation's `schema` UID against the deployment's frozen `EfsSchemaUIDs` and decoding `data` with the SDK's `SchemaEncoder`; an unrecognized schema returns a typed `unknown` passthrough (raw attestation carried through, nothing lost). Given a UID, `efs.decode(uid)` reads `getAttestation` first then decodes (async; `null` when absent).

  New exports: `decodeAttestation`, `buildRawContracts`, `makeEasVerbs`, `revokeAbi`, and the supporting types (`DecodedAttestation`, `DecodedKnown`, `DecodedUnknown`, the per-schema decoded shapes, `EfsRawContracts`, `RawClients`, `EasVerbs`, `EasVerbContext`, `EasWalletClient`, `EasPublicClient`, `RevocationRequest`). Bundle delta ~+1 kB gzip (21.7 kB, well under the 36 kB budget).

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

- 7988118: Fix `efs.fs.list(path, { excludes })` returning empty pages / dropping normal files. The
  filtered directory read (`getDirectoryPageFiltered`) was passed `schemas.anchor` as the
  child-anchor schema bucket, but that argument is the `forSchema` BUCKET KEY the walk
  scans (`_childrenBySchema[parent][schema]`) and the folder-visibility tag `definition` —
  not the schema of the anchor attestation. SDK-written file anchors are bucketed under
  `schemas.data` (DATA_SCHEMA_UID) and folder-visibility tags use `definition =
DATA_SCHEMA_UID`, so the ANCHOR-schema bucket was empty and enabling safety excludes
  skipped ordinary files. Now passes `schemas.data`, matching the production client.
- 99965d2: `resolveLens` now finalizes EVERY lens's resolved output at the common boundary — deduplicating (case-insensitive, order-preserving) and enforcing `MAX_LENSES` with the typed `MaxLensesExceeded`. Previously only the built-in `lens()`/`identity()` constructors finalized internally, so a caller-supplied custom `Lens` object could feed duplicates or 21+ attesters straight into reads like `locate()`/`read()`, failing with an opaque contract/RPC error instead of the documented one and violating `resolveAttesters()`'s promised deduped result. Idempotent for the built-ins.
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

- 1a94902: Two hardening completions: (1) `submitLayeredTier1` asserts the LIVE chain before running the boundary validation gates — their EAS/indexer reads go through the unguarded submit client, so a mutable provider could previously serve another chain's attestation/anchor state to the gates, switch back, and pass the per-layer broadcast assertion with foreign proofs; only plans carrying a gate stamp pay the extra assertion. (2) `buildFileWriteGraph` rejects the documented-invalid `missingParents` + `existingFileAnchorUID` combination up front — a brand-new parent cannot already hold the file's anchor slot, and the slot stamps compare against the deepest EXISTING ancestor in that mode, so an existing sibling's anchor could pass validation while the requested path ended up with no file.
- 0ea08d6: Two more paid-partial-write gaps closed.

  The Overview visibility TAG's `/tags/system` definition is now stamped onto the plan and verified to be an ANCHOR before layer 1 broadcasts. That TAG sits at `m + 3`, so a well-shaped but nonexistent definition was rejected by the resolver only after the DATA, file anchor, mirrors and metadata had mined — a paid, half-applied write. `writes/overview.ts` resolves the definition from the path and refuses ZERO, but `buildFileWriteGraph` is exported, so a direct caller could supply anything. This mirrors the existing gate on ancestor tag targets.

  `efs.props.set(dataUID, 'contentHash', …)` is now validated against the canonical `ContentHash` form. The shared builder checked only `contentType`, so a malformed hash could become the active authoritative claim — and that is worse than a bad `contentType`: `readText`, `readBytes` and `readJson` report `malformed-claim` and throw even when the mirror bytes are perfectly intact, so a single property write could make a healthy file unreadable by default. File writes already persist only canonical hashes; this routes `props.set` through the same boundary.

- 98478b8: Tier-1 writes now bind to an anchor slot that already exists instead of trying to mint it again, so a front-runner can no longer block a file write.

  An anchor slot — a folder, a file path, or a property key such as the `contentType` of a file — is keyed by `(parent, name, bucket)` with no attester, and the EFSIndexer can only accept or reject a mint (EAS has already created the attestation by the time the resolver runs), so minting an existing slot reverts. A file write mints its DATA in one transaction and that DATA's reserved key anchors in the next; in between, the DATA UID is public. Anyone could claim `(DATA, "contentType", PROPERTY)` first, making the second transaction revert after the caller had paid for storage — and a retry minted a fresh DATA and re-opened the same window, so the write could be blocked indefinitely.

  Binding to a claimed slot is safe because a slot holds only a name. Values are PROPERTY plus a binding PIN keyed to the signing attester, and readers resolve the slot without regard to who minted it — the same thing `efs.props.set` already does when updating an existing key. So before each layer is broadcast, the submitter now checks every planned ANCHOR's slot and binds to any that exists. If a slot is claimed while the layer is in flight (a simulation revert or a same-block revert), it re-checks and retries just that layer without the claimed anchor, never starting the write over. A front-runner can therefore cost at most one failed attempt per anchor and can never prevent completion. It never retries a user's rejection, and never retries a failure that no claimed slot explains.

  `LayeredWriteResult` and `Tier1WriteResult` gain `reused` (slots bound to rather than created — kept out of `uids`, so a receipt never claims a slot someone else minted) and `revertedAttemptTxHashes`, which receipts now count in `signatureCount` because each cost the signer a confirmation.

- e9adb0f: Extend the write-path chain guard to the file-write planning reads and the receipt waits —
  the last drift windows in a multi-step write:

  - **`writeFileTier1`** re-asserts the live chain after the caller's entry preflight and
    before its planning reads (parent-anchor resolution, visibility tags, transport
    definitions). A provider that switched chains for those reads — then back before
    storage/submit — could otherwise bake wrong-chain anchor/transport UIDs into the plan.
  - **`submitLayeredTier1`** re-asserts before each layer's `waitForTransactionReceipt`
    (inside the wait try): a provider that drifts after the tx is broadcast no longer waits on
    the wrong chain and falsely reports a mining tx as a partial failure — the drift surfaces
    as the honest outcome-unknown `WriteRevertedError(mined:false)` carrying the in-flight
    txHash, so recovery can re-bind and check it.
  - **`storeOnchain`** re-asserts before each deploy's receipt wait (`requireContractAddress`),
    so a drift after the chunk/manager broadcast fails closed with `WrongChain` instead of a
    misleading "no contract address" that aborts the default no-mirror write.

- 23e661d: Guard the last two write-path planning reads against a drifted public chain:

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

- 0fc48eb: Close a read-path TOCTOU: `readContext` resolved the deployment from the live chain but then
  handed the read engines an UNGUARDED `publicClient`. A mutable EIP-1193 provider that switched
  chains between `liveDeployment()` resolving and the engines' `readContract`/`getCode` calls
  (`fs.read`/`locate`/`info`/`list`) would use the resolved chain's addresses on the new chain —
  false misses / wrong-chain data. `readContext` now wraps the read client with a guard pinned to
  the RESOLVED `deployment.chainId`, re-asserting `live === resolved` before each read and failing
  closed with `WrongChain` on drift. The `chainGuardedPublicClient` proxy now also guards `getCode`
  (the web3:// SSTORE2 read transport); `getEnsAddress` stays unguarded (ENS is cross-chain).
- e1d1de6: `efs.raw.verifyDeployment()` now probes through a chain-guarded client pinned to the resolved
  deployment. It resolved the deployment from the live chain but then ran its `getCode` +
  schema-UID `readContract` checks via the unguarded `publicClient`; a mutable provider that
  switched chains between resolution and the probes would verify the resolved chain's addresses
  against the new chain (or falsely pass on a fork with matching addresses). The probe now fails
  closed with `WrongChain` on drift — the same guard already used by `readContext` and the
  standalone namespace reads.
- 41ee47b: Guard the standalone write verbs' PLANNING reads against a drifted public chain, before they
  feed the plan. `props.set` (key-anchor `resolveAnchor`), `graph.tags.add` (definition
  resolution), and `lists.add` (config→targetType) each ran a public-client read whose result
  shapes the attestation plan BEFORE `submitEdgePlan` reached its chain guard. A mutable
  EIP-1193 public provider on a different chain (while the wallet is back on the deployment
  chain for submission) could resolve a UID/config that only exists on the wrong chain, so the
  plan reuses an anchor absent on the deployment chain — layer 1 mints, layer 2 reverts
  referencing it (a partial write). Each verb now runs the submit context's `assertChain`
  (fail closed with `WrongChain`) BEFORE the planning read, reusing the same context for the
  submit. `lists.remove`'s advisory append-only config read is guarded the same way. `pins`,
  `redirects`, and `lists.create` build plans purely from arguments and need no pre-read guard.
- 2a569b1: Two review fixes: `fs.write`/`setOverview` planning reads (the parent walk, overwrite probe, visibility-tag checks, transport lookups) now run through the chain-guarded client pinned to the deployment — the single entry preflight couldn't cover that multi-RPC window, so a provider drifting mid-planning and back could bake chain-B parent/anchor UIDs into a plan the per-tx guards then submitted on chain A; each planning read now fails closed on drift (pre+post-checked). And cancellation propagates between GATEWAY attempts too — an abort during the first IPFS/Arweave gateway no longer surfaces as `AllMirrorsFailedError` when the transport had another candidate URL.
- 442c841: The hardlink gate hardens further: (1) a hardlink plan whose placement PIN has a symbolic or missing `refUID` now FAILS CLOSED instead of skipping every check — a crafted plan could otherwise mint a non-DATA in an earlier layer and place it into the wrong schema slot unverified. (2) The gate now also proves READABILITY before broadcasting: authorship + schema were not enough, since a self-authored bare DATA (minted via the raw EAS verbs) hardlinked "successfully" and then every `read()` failed `AllMirrorsFailed`. The gate scans for at least one ACTIVE mirror authored by the submitter on the target (raw-count-bounded filtered windows, first-hit early exit) via the new `SubmitContext.indexerAddress` (required for hardlink submissions, wired by the write orchestrator) and the new `FileWriteGraph.mirrorSchemaUID` stamp — both fail closed when absent.
- c2d2679: Three fixes: (1) `submitWriteTier1` enforces the hardlink self-authorship gate at the chain boundary — before any layer broadcasts, a hardlink plan's DATA attestation is read from EAS and the submission is refused with a typed error unless the submitting account authored it (Solidity parity: `EFSLib.ForeignDataUID`); the gate fails CLOSED when the context cannot resolve a signing account or lacks the new optional `SubmitPublicClient.readContract`. (2) List reads re-select the lens attester when the leading candidate's entries evaporate between the selection probe and the follow-up read: `length`, `has`, and `entries` now walk the ranked candidates instead of reporting a false 0/false/empty, while an honest miss under a standing winner still stops the walk (first-attester-wins). (3) `efs.graph.pins.active` with no attester and no connected account now throws `LensRequired` like the other standalone namespaces instead of returning `undefined` — a false absence for a read that never happened.
- 29139e1: The foreign-hardlink family closes out: (1) `buildFileWriteGraph`'s input is now a discriminated union — `FileWriteHardlinkInput` carries NO retrieval metadata by design (the reserved key-ANCHORs are canonical attester-independent PERMANENT slots, so a pure builder re-emitting the triplets for any previously-written DATA would revert the whole layer), and the hardlink branch REJECTS stray metadata at runtime with guidance instead of silently discarding it: the placer must already have authored the DATA and its metadata (self-dedup), or re-publish the bytes / attest metadata via `efs.mirrors.add` / `efs.props.set` after placing. (2) Solidity `EFSLib.place` — the standalone hardlink/move primitive the README advertises — now applies the same `ForeignDataUID` self-authorship gate as `placeExisting`, so a foreign placement reverts instead of producing a visible-but-unreadable file.
- 0d02ef5: Two fixes: (1) The submitter's hardlink gate now also verifies the target IS a DATA attestation — the builder stamps the plan with `FileWriteGraph.dataSchemaUID`, and `submitWriteTier1` compares it against the target's actual schema before broadcasting (a self-authored ANCHOR/PROPERTY target previously produced a confirmed receipt for a file no SDK reader can find; Solidity parity: `EFSLib.NotDataUID`). A hardlink plan without the stamp fails closed. (2) The raw EAS verbs (`attest`/`multiAttest`/`revoke`) apply the same refusal-vs-transport send split as every other send path: a code-less transport failure now throws the new `EasSendUnknown` (op-tagged; broadcast state unknown, may still mine, blind retries duplicate or revert `AlreadyRevoked`) instead of an ordinary classified error, while response-backed refusals stay classified.
- a11c6fc: Two hardlink fixes: (1) Solidity `EFSLib.placeExisting` now reverts `ForeignDataUID` unless the DATA was authored by the calling contract — lens-scoped reads key mirrors and content-hash/type properties on the placement attester, so a hardlink to foreign-authored DATA resolved to a UID with no retrieval metadata visible under the placer's lens (an advertised file that cannot be read); re-publish foreign content with `writeFile` instead. (2) The TypeScript graph builder's hardlink short-circuit now honors `overviewSystemTagDef`: the `system` TAG is emitted in a layer strictly before the placement PIN (same no-untagged-flash ordering as normal writes) instead of being silently dropped, which left a hardlinked Overview visible in safety-filtered directory listings.
- 5390383: Two symmetry completions: (1) the EFSIndexer legs get the last missing send split — a code-less transport loss during `index`/`indexRevocation` now throws the new `IndexSendUnknown` (no hash exists; may still mine; `efs.index(uid)` is the safe idempotent reconcile), the redirect wrappers thread it onto `IndexingIncomplete.indexBroadcastUnknown` with an honest message instead of claiming the leg never broadcast, and the partial receipt counts the signed prompt (the wallet signed before the transport dropped). Refusal responses stay classified. (2) Solidity `setPropertyAt` validates the reused key-anchor before binding: it must be an ANCHOR in the PROPERTY bucket (`NotPropertyKeyAnchor` otherwise) — a PROPERTY bound at a file/folder anchor confirmed UIDs the canonical `resolveAnchor(dataUID, key, PROPERTY)` lookup never reaches, matching the TS reuse path's checks.
- aeaf032: Fix two read/write surface edge cases surfaced in review:

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

- d26feea: Four input-validation/honesty fixes from review: a `NaN`/non-positive `write.onchainAutoLimit` now throws `InvalidArgument` before the size gate (it previously disabled the cap comparison entirely, waving any payload into gas-spending storage deploys); `followRedirects` with a non-finite number throws `InvalidArgument` instead of silently disabling the following the caller explicitly requested; the browser `opaqueredirect` fetch path reports the FOLLOWED response's final URL as `urlUsed` (provenance named the pre-redirect endpoint); and `efs.toJSON` throws `InvalidArgument` for `undefined`/function/symbol roots rather than returning runtime `undefined` against its `string` signature.
- ffc71f8: Three review fixes: every second-leg failure after the SSTORE2 chunk LANDS (abort, chain drift, wallet rejection before/at the manager deploy) now throws the new `OnchainStoreIncomplete` carrying the landed `chunkAddress`/`chunkTx` — the chunk is irreversible and paid for, so recovery can wrap the existing chunk instead of a blind retry paying for a duplicate (post-landed aborts/drifts previously escaped raw, matching neither the layered submitter's model nor the duplicate-spend hazard); attestation hydration now honors its documented revoked-degrades-to-`undefined` contract (EAS returns full records for revoked UIDs, so a direct `eas.attestationsFor` input or a revoke racing an expansion surfaced revoked records as live); and the artifact envelope's version floor is enforced — `0`/negative/fractional versions are `MalformedArtifact` (structural corruption), while newer-than-supported stays `UnsupportedArtifact`.
- 0a541b5: fix(reads): `efs.lists.entries` honors a constructor-level `cursor` for the initial page

  A caller resuming with `efs.lists.entries(listUID, { cursor })` and then iterating / calling
  `byPage()` without a per-page cursor was restarting at offset 0 (only `pageOpts.cursor` was read),
  duplicating entries for anyone who persisted a `Page.cursor`. The first page now falls back to
  `opts.cursor`; subsequent pages thread their own advanced cursor.

- 8d029bf: fix: strict list lens scoping, http gateway guard, plan-before-deploy, reject zero list limit

  - **List reads stay scoped to an explicit lens.** `efs.lists.entries`/`length`/`has` only fall
    back to the curator when NO lens intent was expressed (no per-call lens, no client
    `defaultLens`, no connected account). A caller reading with lens Alice no longer receives
    curator Bob's entries when Alice's view is empty.
  - **Reject `http://` gateway URLs.** The plaintext-HTTP guard now runs for EVERY concrete fetch
    URL, so an `http://` entry in `ipfsGateways`/`arweaveGateways` is blocked unless
    `allowInsecureHttp` is set (previously only direct `http://` mirrors + redirects were guarded).
  - **Plan before deploying bytes.** `fs.write` runs the read-only ancestor visibility-tag planning
    BEFORE the irreversible on-chain SSTORE2 storage deploy, so a failing `getActiveTagWeight` read
    aborts before any gas is spent.
  - **Reject non-positive list-entry limits.** `efs.lists.entries({ limit: 0 })` (and `.byPage({ limit: 0 })`)
    threw the iterator into an infinite no-progress loop; they now throw `InvalidArgument`.

- 5dae505: Two review fixes: (1) `efs.lists.add`/`remove` now pin their list-config read to the already-selected deployment and its chain-guarded read client, like every other write planner — previously the read went through a live re-resolving read context, so a provider drifting after the one-time chain assert could serve a chain-B list mode into a chain-A plan (wrong-mode entry encoding, a false/skipped append-only rejection, or a submit that can only revert). (2) When a redirect's follow-up index tx BROADCASTS but its confirmation fails, the partial recovery receipt now counts that signed-and-sent transaction in `signatureCount` (a leg that never broadcast still adds nothing), so persisted recovery artifacts and confirmation-count UIs no longer underreport the write.
- 12480b8: Add the LIST read surface (`efs.lists.*`) — the next read gap after files/edges — plus a deferred `efs.sorts.*` stub. Reads only; additive (new top-level namespaces), tree-shakeable, type-safe. Built over the frozen `ListReader` view (ADR-0044/0046).

  - **`efs.lists.get(listUID, { lens? })`** → `ListConfig` — the LIST config + identity via `ListReader.getMode` (decodes the LIST attestation DIRECTLY from EAS, **schema-checked before decode**, so a non-LIST UID returns `exists:false` rather than a spoofed config). Returns `allowsDuplicates`, `appendOnly`, `targetType` (mapped to the `'any' | 'addr' | 'schema'` literal union), `targetSchema`, `maxEntries`, and the `curator`. NOT lens-scoped (the config is the curator's own declaration, read by UID); `exists:false` on absence — a probe that never throws.
  - **`efs.lists.entries(listUID, { lens?, limit?, cursor? })`** → `EfsList<ListEntry>` — the lens-scoped, ordered, deduped entries as a lazy async-iterable (`for await` / `.byPage({limit,cursor})` / `.toArray({limit})`, same shape as `fs.list`). Honors the list's `targetType` (ADDR → checksummed address from the `identityKey`; SCHEMA → target UID; ANY → opaque member key — all decoded inline from the denormalized `Entry`, zero per-entry `getAttestation` calls) and `allowsDuplicates` (dedupe by identity key, first-occurrence-wins; global across pages for iteration/`toArray`, page-local for `byPage`). Each entry carries `entryUID`, `targetKind`, `target`, and the resolving `attester`. Append-only vs revocable read identically — the view already excludes revoked entries; the distinction surfaces on `ListConfig.appendOnly`.
  - **`efs.lists.length(listUID, { lens? })`** / **`efs.lists.has(listUID, target, { lens? })`** — O(1) active-entry count and membership probe (`ListReader.length` / `countOf`). `has` derives the on-chain `identityKey` per the list's targetType (address right-aligned for ADDR; the UID/member-key verbatim otherwise). Both throw the new `ListNotFound` when no LIST exists at the UID (entry reads of a non-existent list are a caller error, unlike the `get` probe).

  **Lens semantics.** `get` is by-UID (lens accepted for symmetry, ignored). The entry reads (`entries`/`length`/`has`) are lens-scoped and **first-attester-wins**: the lens resolves through the shared ladder (`opts.lens` → `defaultLens` → wallet → SystemAccount), then the SDK picks the FIRST resolved attester that has any entries (one `length` read per candidate, fanned with `Promise.all` for multicall coalescing) — mirroring file placement's first-wins, since list curation is per-attester and the on-chain reads key on a single `attester`. The `curator` is folded in as a last candidate so a single-curator list reads its own entries with no lens knowledge.

  **SORTS — stubbed (deferred), not implemented.** `efs.sorts.get` / `efs.sorts.apply` are present with `@experimental` signatures but throw `NotImplemented` with a pointer to `efs.lists.*`. SORT_INFO is NOT in the frozen schema set / deployments registry (no `sortOverlay` address, no `sortInfo` UID — see `chain/deployments.ts`), so there is no stable on-chain encoding to read against. Rather than guess the `EFSSortOverlay` encoding, the namespace + types land additively now and the real implementation drops in (with a documented TODO) once SORT_INFO is frozen and seeded.

  New error codes/classes: `ListNotFound`, `WrongListTargetType`. New public types: `ListConfig`, `ListEntry`, `ListTargetType`, `ListReadOptions`, `ListGetOptions` (+ the deferred `SortInfo`/`SortSourceType`/`SortReadOptions`). Bundle stays well under budget (25.1 kB gzip / 36 kB).

- a72cb02: Add the LIST write surface (`efs.lists.create` / `add` / `remove`) — pairing the just-landed read surface (`get`/`entries`/`length`/`has`). Additive, tree-shakeable, type-gated like the other writes (present only on a write-capable client; the attester is the connected wallet). The encodings mirror the Solidity `EFSLib` wrappers exactly (cross-checked against the deployed ListResolver/ListEntryResolver) and route through the SAME Submitter seam as `fs.write` (pure builders → `submitLayeredTier1` → normalized `WriteReceipt`).

  - **`efs.lists.create(config)`** → `WriteReceipt & { listUID }` — mint a LIST: `abi.encode(allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries)`, refUID 0, recipient 0, **non-revocable** (mirrors `EFSLib.createList`). Validates the ListResolver invariants client-side BEFORE submit — `targetType` ≤ 2; SCHEMA mode requires a nonzero `targetSchema` and non-SCHEMA requires zero; `appendOnly && allowsDuplicates ⇒ maxEntries != 0` — throwing the new typed `InvalidListConfig` rather than letting the chain revert. One signature; the minted attestation's UID is the returned `listUID`.
  - **`efs.lists.add(listUID, target, opts?)`** → `WriteReceipt` — add a LIST_ENTRY, routed by the list's `targetType` (read once via `lists.get`, or pass `{ targetType }` to skip the read). ANY/SCHEMA → `abi.encode(listUID, target)` with recipient 0, refUID 0, revocable (mirrors `EFSLib.addEntry`); ADDR → the member address rides in `recipient`, payload `abi.encode(listUID, bytes32(0))` (mirrors `EFSLib.addAddressEntry`). Target shape is validated vs mode before submit (`validateAddTarget`): ADDR needs a 20-byte address (incl. the explicitly-allowed `address(0)`); ANY/SCHEMA need a nonzero 32-byte UID/member key. Throws `InvalidListConfig` on a mismatch, `ListNotFound` when no LIST exists. One signature.
  - **`efs.lists.remove(entryUID, opts?)`** → `Hex` — revoke a LIST_ENTRY via `efs.eas.revoke` (the listEntry schema). Pass `{ listUID }` to reject an **append-only** list up front with the new typed `ListAppendOnly` (no chain round-trip); a bare entryUID doesn't carry its list, so without the hint the resolver enforces append-only on-chain.

  Mechanism: the writes build a minimal `FileWriteGraph`-shaped plan and submit through `submitLayeredTier1` (the mechanism-neutral core). To support the one ADDR-mode entry whose `recipient` is intentionally nonzero (the protocol's address-target form), `PlannedAttestation` gains an optional `recipient` (default `ZERO_ADDRESS`, honored in the submitter's `materializedEntry`), and the `kind` union gains `'LIST'` / `'LIST_ENTRY'`. `create` uses a new `submitEdgePlanWithUID` to return the minted LIST UID alongside the receipt.

  New error codes/classes: `InvalidListConfig`, `ListAppendOnly`. New exported builders/validators: `buildCreateListPlan`, `buildAddEntryPlan`, `validateListConfig`, `validateAddTarget`, `TARGET_TYPE_CODE`, `submitEdgePlanWithUID`, `makeListsWriteNs`, plus the `ListCreateConfig` / `ListAddOptions` / `ListRemoveOptions` types and the `EfsListsWriteNs` client type. Bundle stays well under budget (26.1 kB gzip / 36 kB).

- 7b50f3d: Two fixes: (1) `props.list`'s `maxKeys` can only LOWER the scan ceiling, never raise it — `maxKeys: 1_000_000` previously replaced `MAX_PROPERTY_SCAN` and re-opened the unbounded enumeration the default exists to prevent; non-positive or non-integer values are now rejected. (2) Mirror-URI preflight treats `http` as a known scheme (`resolveTransport` supports it behind `allowInsecureHttp`), so a malformed `http://` locator no longer slips through as an unknown/custom scheme; it is parsed with the opt-in enabled, validating structure at write time without imposing the reader's insecure-transport policy on the write.
- cf15969: The readability invariant closes out across write entry points: (1) `buildFileWriteGraph` rejects a byte plan with an empty mirror set — the exported builder could mint a fully-confirmed file whose every `read()` fails `AllMirrorsFailedError` (the orchestrated `fs.write` paths already auto-store or reject). (2) Solidity `writeFile` reverts the new `EmptyMirrorSet` before anything mints when `w.mirrors` is empty (the docs previously said "may be empty"). (3) `redirects.set` gates DIRECT symlink→DATA links: path resolution reports the symlink author as `resolvedBy` and reads scope retrieval metadata to that address, so a symlink at a DATA whose mirrors live under someone else resolved but could never be read — the author must have their own active mirror on the target (or symlink to the file's ANCHOR, where the walk uses the placement winner's metadata); symlink→ANCHOR and sameAs/supersededBy edges are unaffected.
- 63dc6ff: `buildMirrorPlan` now runs the shared `validateMirrorUri` preflight — the one mirror path that was missing it. MirrorResolver accepts any nonempty bounded string, so a direct caller of the exported builder could mint a MIRROR carrying a locator the SDK itself refuses to resolve (`ipfs://!`, `web3://0x1234`), leaving the DATA unreadable when it was the only mirror. Custom/unknown schemes still pass through untouched (the ADR-0056 escape hatch).
- bec207e: Four review fixes: (1) Mirror scans (the byte-fetch path and `efs.mirrors.list`) now page over the RAW referencing count via a shared scanner — the view filters revoked entries WITHIN each physical window, so the old short-window break treated a filtered page as exhaustion and silently dropped every active mirror behind a revoked slot (potentially `AllMirrorsFailedError` with a healthy mirror in slot 51); an exact page-multiple count also no longer sends an extra read the contract reverts (`InvalidOffset`). (2) New `WriteSendUnknownError`: a code-less transport failure during `eth_sendTransaction` (connection drop after the request may have reached the node) is no longer labeled `WriteNotSentError` — broadcast state is UNKNOWN, the tx may still mine, and no hash exists; a classified refusal response still proves not-sent. (3) `identity()` accepts non-checksummed mixed-case addresses as literal identities (`isAddress` non-strict, matching the finalize boundary) instead of misrouting them into ENS lookup. (4) The unreachable revoked-state promise is removed: lens-scoped views are active-only, so a revoked placement reads as absence — the `Revoked` error class and `FileInfo.verified: 'revoked'` union member are gone, and the docs state the absence semantics explicitly.
- 9012353: Mirror transport definitions are now preflighted before layer 1 broadcasts. The pure builder shape-checks each `transportDefinition` (nonzero bytes32) and stamps the plan's distinct transport UIDs; the submission boundary then verifies MirrorResolver's actual predicate — each definition must be an ANCHOR attestation descending from `/transports/` (walking parents via each anchor's `refUID`, the same edge the contract's `getParent` reports, under the contract's depth bound). Previously an arbitrary or non-`/transports/` definition passed the builder, mined the DATA + file-ANCHOR layer, and only reverted at the layer-2 MIRROR — a paid partial graph. The gate is skipped for plans without mirrors and fails closed when the context cannot read.
- 492d239: Add standalone MIRROR write verbs — `efs.mirrors.{add,remove,list}` — completing write parity. A file write (`fs.write`) already publishes MIRRORs inline (the `web3://` on-chain mirror, plus any caller `opts.mirrors`), but there was no way to add a retrieval method to an EXISTING DATA after the fact. A MIRROR is the cardinality-N edge `MIRROR(refUID = dataUID, data = (transportDefinition, uri))` (MirrorResolver.sol; ADR-0011/0015), authored from the connected attester.

  - **`add(dataUID, { uri, transport? })` → `WriteReceipt`** — publish one MIRROR (ONE signature). Reuses the EXACT MIRROR encoder the file-write DAG emits (`SchemaEncoder("bytes32 transportDefinition, string uri").encodeData([transportDefinition, uri])`, `refUID = DATA`, `revocable = true`). The transport anchor is resolved up front (so a bad/missing transport throws the typed `MissingTransport` instead of letting MirrorResolver revert with `InvalidTransport`): an explicit `transport` UID wins; else it is derived from the URI's scheme via the deployment's `transports` map — the same `deployment.transports?.[scheme]` lookup `writes/file.ts` does for the inline web3:// mirror — with `ar://` normalized to the `arweave` key; else it falls back to resolving the `/transports/<scheme>` anchor path on-chain via the indexer. The descendancy/URI checks remain on-chain (a violation surfaces as `ContractReverted`). MIRROR is not cardinality-1 (ADR-0015), so `add` never supersedes a prior mirror.
  - **`remove(mirrorUID)` → `Hex`** — revoke a MIRROR by its own UID via `efs.eas.revoke` (MIRROR schema). MIRROR is revocable (MirrorResolver REQUIRES `revocable=true` at write time), so the revoke is always valid.
  - **`list(dataUID, { lens })` → `MirrorRecord[]`** — the active mirrors the lens attester(s) authored on the DATA, with `{ uid, transportDefinition, uri, attester }`. Lens-scoped on-chain via `EFSFileView.getDataMirrors` (revoked-excluded; the same read the fetch engine uses), so a foreign attester's mirror never surfaces under someone else's lens (ADR-0056). The cross-attester `getDataMirrorsAllAttesters` is deliberately NOT exposed (debug/discovery only).

  Type-gated like `graph`/`props`/`redirects` — the write verbs are present only on a write-capable client (a no-wallet runtime call throws via the wallet-bound submit/revoke). New exports: the `efs.mirrors` namespace, `buildMirrorPlan`, `resolveMirrorTransport`, and the `MirrorsNs`/`MirrorAddOptions`/`MirrorListOptions`/`MirrorRecord` types.

  Transport scheme derivation: `web3`/`ipfs`/`arweave` (incl. the `ar://` alias)/`https`/`data`/`magnet` derive automatically when the deployment seeded them (or a `/transports/<scheme>` anchor exists on-chain); any other scheme requires an explicit `transport` UID.

- 49bc089: Two follow-up fixes:

  - **`efs.mirrors.add` rejects an empty/blank URI** with a preflight `InvalidArgument`,
    matching the guard `fs.write` already has. Previously an explicit `transport` UID made
    `resolveMirrorTransport` return before any URI check, so `mirrors.add(data, { uri: '',
transport })` encoded an empty URI into the MIRROR plan and the caller signed a tx that
    MirrorResolver could only revert.
  - **The `web3://` raw-SSTORE2 fallback is now scoped to genuine on-chain "not a chunk
    manager" misses.** It previously caught _any_ `chunkCount()` failure, so a transport/RPC
    error (timeout, rate-limit) on a real chunk-manager mirror would return the manager's own
    bytecode as garbage file bytes and pre-empt later mirrors. The fallback now triggers only
    when the call returned `0x` (viem `ContractFunctionZeroDataError`/`AbiDecodingZeroDataError`);
    transport/RPC errors propagate as a failed attempt so the fetch engine tries the next mirror.

- 75e0f48: Two mirror-readability fixes: (1) the write preflight now rejects unassigned multibase prefixes instead of accepting any alphanumeric string of plausible length — `ipfs://notavalidcid` no longer mints a MIRROR no gateway can parse. Assigned-but-undecoded multibases (base36 `k`, base32hex `v`, …) are screened against their own alphabet, so a resolvable CID is still never refused. (2) Mirror scans now window the NEWEST 500 raw slots rather than the oldest. The raw referencing array is append-only (revoking never frees a slot), so past 500 records the SDK was pinned to the oldest 500 and could not see any newly added mirror — while `EFSRouter._bestMirrorUri` caps at the same 500 walking in reverse and serves them fine. The SDK now selects the same set the router does.
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

- ee29325: Numeric-option validation swept across the remaining public entry points (same class as the prior wave, exhausted this time): `resolveTransport` rejects non-finite/non-positive `maxBytes` directly (callers bypassing `fetchVerified` were unprotected — a NaN cap decoded arbitrarily large `data:` payloads); `redirects.history` validates `maxHops` (NaN walked zero edges and mis-reported the start as history; fractional caps now floor); `verifyAttestationUID` bounds `maxBump` to the uint32 bump range (Infinity hung the event loop on synchronous keccak work; NaN false-negatived); `fetchVerified` validates `timeoutMs` (NaN fired the abort timer immediately). Also: the `efs.account.capabilities()` probe now routes `getCode` through the chain-guarded client pinned to the sampled live chain — a provider that drifts mid-probe fails closed (`WrongChain`) instead of caching another chain's bytecode/capabilities under the sampled chain's key.
- 81a1df4: Implement the on-chain tag-exclusion directory filter and folder Overviews (ADR-0011 / contracts ADR-0054). Both were typed-present but behavior-absent (`fs.list({ excludes })` threw `@experimental`; `fs.overview`/`setOverview` threw `NotImplemented`); they are now wired.

  - **`efs.fs.list(dir, { excludes, minWeights })`** — a non-empty `excludes` now routes the listing to the on-chain `EFSFileView.getDirectoryPageFiltered` (the filter runs server-side — there is **no** per-entry tag fan-out / N+1; it is the same single `readContract` per page as the unfiltered path). Each `excludes` entry is a TAG-definition UID passed through verbatim, or a human label (`'system'`/`'nsfw'`, the exported `SAFETY_EXCLUDES`) resolved to its `/tags/<name>` definition UID **before** the first read (no leak window). `minWeights` pairs 1:1 with the resolved defs; omitted/mismatched ⇒ an all-zero vector (the ADR-0042 default, avoids the on-chain length-mismatch revert). The filtered view returns an opaque `bytes` cursor and, under its phase-1 scan budget, can return an **empty page with a non-empty cursor** — the iterator keeps paging until the cursor is empty (empty ≠ end-of-list). A filtered cursor is method-bound: feeding a base-10 (unfiltered) cursor into the filtered path (or vice-versa) throws `CursorInvalid`. On-chain caps (attesters 1–20, excludes ≤ 8, `maxItems > 0`) fail fast with `InvalidDirectoryQuery`.

  - **`efs.fs.overview(container, opts?)`** — reads the folder's Overview (`README.md`) by **exact path** (`[…container, 'README.md']`), never a directory scan, lens-scoped. Returns a discriminated `OverviewResult`: `none` (absent — the common case, no throw), `markdown` (decoded UTF-8 `text` + `source: 'onchain'|'mirror'`; a README with markdown/text or **no** contentType is treated as markdown), `binary` (a non-markdown contentType — surfaced honestly, not mis-rendered), or `too-large` (the attested `size` exceeds `MAX_RENDER_BYTES` — bytes are **not** fetched).

  - **`efs.fs.setOverview(container, markdown, opts?)`** — composes the normal file-write pipeline at `[…container, 'README.md']` forced to `text/markdown`, and applies the `system` TAG on the README's **own** anchor in the write-graph layer **strictly before** the placement PIN — so the README is already hidden the instant it becomes visible (it never flashes as a visible untagged sibling). The marker def is the resolved `/tags/system` anchor — the same def the directory filter excludes on, so a `SAFETY_EXCLUDES` listing already hides the Overview from its own folder. Fails closed (`InvalidArgument`) when the deployment has no `/tags/system` rather than writing an untagged README. Re-running supersedes the prior README's placement PIN in O(1) (edit in place). Wallet-gated like `fs.write`.

  No new schema, contract, or reserved key — `README.md` + the existing `/tags/system` folder-visibility TAG are the entire Overview convention. The write-graph builder gains one optional, additive input (`overviewSystemTagDef`); a normal `write` is byte-identical (no layer shift) when it is absent.

- 4603d7b: Reserved property values are now validated by a single shared rule that every entry point calls, instead of a check per door.

  The exported `buildFileWriteGraph` encodes `contentType` straight into the reserved PROPERTY and produced a plan the submitter mines happily, so a direct caller could persist `'not-a-media-type'` — or a media range like `text/` + wildcard — as authoritative metadata that makes `fs.overview()` misclassify the file. That was the third public door onto the same value: `fs.write`'s options and `efs.props.set` were guarded in earlier fixes, one at a time, each leaving the next open.

  `assertReservedPropertyValue` now holds the whole reserved-key contract (`contentType`, `contentHash`, `size`) and is called from `buildPropertyPlan` and from the graph builder's reserved-property construction. Non-reserved keys are untouched — this is a reserved-key contract, not a value policy for every property. Note the byte-write path already verified `contentHash` and `size` against the supplied bytes, which is stronger than a canonical-form check; those guards are unchanged and now pinned by tests so the shared assertion cannot silently weaken them.

- 9a57021: fix(reads/writes): cap Overview fetch at the render limit; hydrate DataRef expand; reject unbound wallets

  - **Overview render cap.** `efs.fs.overview` now passes `maxBytes: MAX_RENDER_BYTES` into the
    fetch. The pre-fetch `size`-PROPERTY check is best-effort and an untrusted Overview can lie
    about it (missing/malformed/under-reported), so the cap is now enforced during the fetch —
    the reader stops buffering past `MAX_RENDER_BYTES` instead of letting an attacker force a
    huge folder header. `FetchOptions.maxBytes` is now a public read option, forwarded to the engine.
  - **DataRef `expand` hydration.** `read(ref, { expand: ['attestations'] })` (the common
    `locate() → read(ref)` two-step) previously skipped hydration on the DataRef early return, so
    `file.attestations` was `undefined` even though the generic signature narrows it to set. It now
    routes through the same expansion (hydrating the contentHash record; placement is absent, since
    a bare ref has no PIN).
  - **Unbound wallet.** `fs.write` now throws `WalletRequired` when the wallet client has no bound
    account, instead of attesting under the zero address (lenses, visibility planning, and the
    receipt's `resolvedBy` all key on the real attester). Matches the edge-write gate.

- 2c2f1d7: fix(reads/writes): Overview fails closed on bad verification; hardlink plans reuse existing anchors

  - **Overview verification.** `efs.fs.overview` rendered `file.text()`/`file.bytes` without checking
    `file.verification`, so a tampered or unverifiable README could display as a folder header with no
    warning (the result has no status field). It now fails closed — throws `ContentHashMismatch`/
    `MalformedClaim`/`MissingContentHash` unless `verify:false` — matching the bare-value read helpers.
  - **Hardlink anchor reuse.** The hardlink/relink graph branch returned before the
    `existingFileAnchorUID` handling, so relinking to an existing path still minted a fresh (permanent)
    file ANCHOR and reverted on the duplicate slot. It now honors `existingFileAnchorUID` too — reuses
    the existing anchor and lets the placement PIN supersede.

- 1e5aad3: `fs.overview()`'s `source` field now derives from the mirror the fetch ACTUALLY used, not from mirror presence — an Overview with both `web3://` and off-chain mirrors previously reported `source: 'onchain'` even when an HTTPS/data: mirror served the bytes (or `transports` excluded web3), inviting consumers to offer `setOverview` editing for read-only mirror-hosted bytes. Supporting this, `EfsFile` gains an optional `mirrorUsed` provenance field (the winning mirror URI, populated by the fetch path).
- 68d3d8a: The Overview `system` marker now targets the file's DATA instead of its file-ANCHOR. `EFSFileView.getDirectoryPageFiltered`'s per-item exclusion predicate classifies items by anchor type and, for FILES, resolves each placement's DATA UIDs and tests exclude TAGs on those (the anchor branch is folders-only, per the ADR-0054 asymmetry) — so the anchor-targeted marker never actually hid the Overview from `fs.list(container, { excludes: ['system'] })`, contradicting `setOverview`'s promise. The normal path tags the fresh DATA symbolically; the hardlink branch tags the concrete pre-existing DATA. Layer ordering is unchanged (the TAG still mines strictly before the placement PIN).
- 9448c13: Fix a batch of P1 correctness + quick-win findings from the SDK review:

  - **`fs.info().verified`** no longer reports `'matches-author'` without ever hashing bytes — it returns `'unchecked'` (the honest status for a metadata-only read). `matches-author`/`mismatch` are reserved for the byte path (`read`/`readText`/…), which actually compares bytes.
  - **Provenance read** (`resolvePlacement`'s placement-PIN lookup) no longer swallows RPC/transport errors into `ZERO_UID`. A legitimately empty slot still surfaces as no provenance; a transient RPC failure now propagates through the `classifyError` funnel instead of silently emptying provenance.
  - **`CallStatus` and `OperationKind`** are now open unions (`| (string & {})`), matching `EfsErrorCode`/`TransportName`/`WriteMechanism`, so EIP-5792's evolving status wire format and new protocol op-kinds aren't a semver-major. Added `'redirect'` to `OperationKind` (the REDIRECT schema is frozen + in the registry).
  - **Default IPFS gateways**: dropped the decommissioned `cloudflare-ipfs.com`; added `trustless-gateway.link` (kept `ipfs.io` + `dweb.link`).
  - **`SYSTEM_LENS` read default**: a no-wallet, no-lens read now falls back to the deployment's SystemAccount instead of throwing `LensRequired`, so a public file reads in one line (`createEfsClient({ provider, chain }).fs.readText('/path')`). `LensRequired` is thrown only when even the SystemAccount is unavailable.
  - **`list({ excludes })` honesty**: `excludes`/`minWeights` are marked `@experimental — not yet implemented` and the throw message now points at ADR-0011.
  - **`NotImplemented`** accepts an optional `{ alternative, tracking }` so the message is a pointer, not a dead end. The `overview`/`preview`/`setOverview`/`batch` stubs now suggest a usable workaround.
  - **Docs**: the package `README.md` quickstart is regenerated from the real surface (`read`/`readText`/`readBytes`/`readJson`/`locate`/`info`/`exists`/`list`/`write`); the old `efs.fs.read(...).data` + nonexistent `efs.fs.fetch` snippet is gone.

- ba7a156: Harden three P2 review findings in the off-chain fetch engine and the Tier-1 write submitter.

  - **Reject plaintext `http://` as the web transport (security).** ADR-0010 names `https://` as the web transport, but `resolveTransport` accepted `http:` (labelled `TRANSPORT.https`) and the fetch engine followed `http://` redirects — so attacker-authored mirror metadata could downgrade retrieval to cleartext (bytes stay hash-verified, but availability/privacy/provenance are tamperable). `http://` mirror URIs and `http://` redirect targets are now **rejected by default** (`UnsupportedUriError` / a refused redirect). A new opt-in `allowInsecureHttp?: boolean` is plumbed through `resolveTransport`, the engine's `FetchVerifiedOptions`, and the public `FetchOptions` (forwarded from `reads/fetch.ts` like `allowPrivateHosts`) for trusted sources such as a local dev mirror. `https://` is unaffected. On the browser opaque-redirect path the platform (mixed-content + CORS) owns the downgrade block; the SDK's check is authoritative on the Node/undici manual-redirect path.

  - **Bound the raw `data:` base64 body before decoding (allocation guard).** A `data:;base64,` mirror that is mostly percent-encoded filler (e.g. `%20` repeated far past `maxBytes`) has zero _significant_ base64 chars, so it slipped past the `significantBase64Chars()` precheck — yet `decodeURIComponent` would still materialize the entire raw string before `decodeBase64` stripped it, bypassing the cap. The precheck now also bounds the **percent-decoded raw length** against `maxBytes` (scanned without materializing the string) and rejects oversized filler before any full-payload allocation.

  - **Split write failure into no-tx / tx-unknown / mined-reverted (error model).** `submitLayeredTier1` previously wrapped every failure as `WriteRevertedError`, so callers could not tell a safe retry from a possible duplicate. Now: a `writeContract` throw (no tx broadcast — safe to retry) raises the new **`WriteNotSentError`** (no `txHash`); a receipt-wait failure after a hash exists raises **`WriteRevertedError`** with `mined: false` carrying the in-flight `txHash` (may still mine — duplicate risk); and a `status: 'reverted'` receipt raises `WriteRevertedError` with `mined: true` carrying the `txHash`. All three preserve the prior-layer landed `ref → UID` map. The standalone edge/value writes share this loop via `submitLayeredTier1`, so they inherit the same split. `WriteNotSentError` is exported from the package.

- 95c8c95: Two chain-guard error-model refinements:

  - **A mid-write chain switch yields the partial-write error, not a bare `WrongChain`.** When a
    multi-layer write has already mined an earlier layer and the pre-send chain guard then fails,
    `submitLayeredTier1` now folds it into the no-tx `WriteNotSentError` (`PartialBatchFailure`) —
    carrying the landed-UID map for recovery, with the `WrongChain` as `cause` — instead of letting
    the guard escape raw and stripping the partial-write context. A drift on the FIRST/only layer
    (nothing landed) still escapes as raw `WrongChain` (no partial write to describe).
  - **A systemic `WrongChain` escapes attestation hydration.** `attestationsForUIDs` (backing
    `expand:['attestations']` and `efs.eas.attestationsFor`) mapped every per-UID rejection to
    `undefined`. A systemic `WrongChain` (the guarded client failing closed after a post-resolution
    drift) was thereby swallowed into empty/missing attestations that looked like genuine absence.
    It now re-throws a `WrongChain` rejection; only true per-UID absence/revocation/transient
    failures degrade to `undefined`.

- 4363d01: Two fixes:

  - **`props.list` pins ALL its reads to one resolved chain.** The prior guard only covered the
    anchor-page read; the per-anchor `getAttestation` still used the unguarded `publicClient`, and
    the value reads went through `readContext()`, which RE-RESOLVES `liveDeployment()` (a second,
    possibly-different deployment). A provider that switched chains mid-list would then decode
    chain-A anchor UIDs against chain B (wrong/empty values). All reads now route through the
    guarded client pinned to the single resolved deployment; the value reads use that pinned
    context instead of a re-resolving `readContext()`.
  - **`lists.has` validates ADDR-mode target width.** `Address | Hex` is not runtime-distinguished,
    so a 32-byte UID whose trailing 20 bytes matched a listed address was silently truncated+padded
    into a colliding membership key — a false `true` for the wrong target kind. `has` now rejects a
    non-20-byte address target (`InvalidArgument`), mirroring the write-side `validateAddTarget`.

- d7355a5: The placement-gate family closes on the TypeScript side: (1) `efs.graph.pins.place` now reads the target attestation through the chain-guarded client and refuses both foreign-authored DATA (a placement whose mirrors/properties are invisible under the placer's lens — `ForeignDataUID` parity) and self-authored non-DATA targets (the PIN would index under the target's actual schema while `pins.active()` and file resolution read the DATA slot — `NotDataUID` parity) before anything broadcasts. (2) The hardlink authorship/schema gates moved from `submitWriteTier1` into `submitLayeredTier1` — the common boundary every exported executor funnels through — so combining the exported builder with `submitLayeredTier1` or the edge submitter can no longer bypass them (edge plans are `hardlink: false`, so this is a no-op for them).
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

- 63c869c: Placement PIN provenance is now snapshot-consistent: the read path exposes `placementPinUID` (and thus `sourceUIDs.placement` / expanded placement attestations) only when the active PIN slot's `targetID` matches the winning DATA returned by the path resolution. A concurrent re-placement landing between the two sequential reads previously attached the NEW placement's PIN to the OLD DataRef, letting provenance contradict the data it rides with; on mismatch the PIN is now withheld exactly like a legitimately empty slot.
- 0ff0df6: Two preflight fixes: (1) `submitLayeredTier1` validates the WHOLE plan's symbolic wiring before broadcasting layer 1 — every symbolic reference must name a ref minted in a strictly earlier layer, and ref ids must be unique. A malformed later layer previously mined (and charged for) its earlier layers first, then threw a generic error carrying none of the structured partial-write recovery state. (2) Mirror write-preflight decodes IPFS CIDs properly (multibase + CID structure: CIDv0 base58btc, CIDv1 in base32/base16/base58btc) instead of only checking the alphabet, so `ipfs://x` no longer mints a MIRROR that no gateway can resolve. Read behavior is deliberately unchanged — `resolveTransport` stays as tolerant as the gateways, the same read-tolerant/write-strict split used for `web3://`.
- 075ac9f: Refactor the write path onto the pluggable `Submitter` execution seam from the verified-wallet architecture (`planning/Designs/sdk-wallet-architecture.md`), so the deferred account-abstraction work plugs in WITHOUT touching the core. Purely additive + a thin re-route — **behavior is unchanged**: Tier-1 (any-wallet, multi-signature) is still the only live strategy.

  - **Types** (`src/types.ts`): added the internal `AccountProfile` (`address`/`kind`/`batchExecution?`/`sponsorable`/`canRunInAccountRoutine`/`raw?`) and the public curated `AccountCapabilities` (`{ kind, canOneSig, gasless, sponsored }`). Extended `WriteReceipt` with `gasless?` and an honest-receipt `reason?` (`{ selected, why }`) so a UI can explain why it signed N times.
  - **Submitter seam** (`src/writes/submitter.ts`): the `Submitter` interface (`mechanism` + `submit(plan, ctx)`) — the single execution chokepoint. `Tier1Submitter` wraps the existing `submitWriteTier1` + the receipt mapping (moved here from `file.ts`), stamping `mechanism:'sequential'`, `gasless:false`, `reason:{ selected:'sequential', why:'dependent-dag-needs-sequential' }`. Tier-1's thrown `WriteRevertedError` is kept as the partial-write boundary (its existing return-vs-throw contract — not swallowed into a `partial` receipt; that normalization is a later slice).
  - **Detection** (`src/writes/detect.ts`): pure, cached-per-`(address, chainId)` `detectAccount(client, address, chainId) → AccountProfile` — `getCode` → `kind` (`0xef0100…`→7702-delegated, `0x`→eoa, other→smart-account); unwraps the nested EIP-5792 `getCapabilities` shape (`caps[chainId].atomic.status` / `paymasterService.supported`) into `batchExecution`/`sponsorable`; tolerates wallets without `getCapabilities` (→ undefined). `canRunInAccountRoutine` is `false` (no in-account adapters yet). Deliberately OFF the write hot path: `fs.write` never triggers it, so current write latency does not regress.
  - **Selection** (`src/writes/select.ts`): pure `selectSingle(profile, plan) → Submitter` — the documented priority ladder (in-account routine if `canRunInAccountRoutine`, else Tier-1). Returns `Tier1Submitter` always today; fixture-testable.
  - **Re-route**: `efs.fs.write` now routes through `selectSingle(...).submit(plan, ctx)` (the single chokepoint the AA submitters extend) instead of hard-calling the Tier-1 submitter. Added `efs.account.capabilities()` → the curated `AccountCapabilities` (lazy `detectAccount` + projection).

  The deferred AA work (5792 / 7702 / 4337 submitters) plugs in by implementing `Submitter` and returning it from the first ladder branch of `selectSingle` — no change to the write orchestrator. New exports: `AccountProfile`, `AccountCapabilities`, `Submitter`, `SubmitterContext`, `Tier1Submitter`, `selectSingle`, `detectAccount`, `toCapabilities`, `invalidateAccountProfile`, `kindFromCode`, `unwrapCapabilities`, `DetectClient`. Bundle: 22.43 kB gzip (well under the 36 kB budget).

- 25e1bd7: Three review fixes: a TRANSIENT `getCapabilities` failure no longer freezes a fulfilled no-capabilities profile into the connector cache — only a rejection the classifier identifies as `UnsupportedMethod` (EIP-1193 4200 / method-not-found) is a durable, cacheable answer; anything else falls back for that call and re-probes on the next, so `efs.account.capabilities()` can't permanently report `gasless: false` off one RPC hiccup. `parseWriteReceipt` enforces the CLOSED `reason.why` union (branding an unknown literal broke exhaustive switches) and rejects a `reason.selected` inconsistent with `mechanism` (it documents itself as mirroring it). And the envelope's `ext`, when present, must be a plain record — `null`/arrays/scalars die as `MalformedArtifact` instead of flowing through a signature promising `Record<string, unknown>`.
- 89d4bfb: Fix two write-path edge cases surfaced in review:

  - **`props.list` now enumerates property keys via the canonical, attester-independent
    anchor set** (`EFSIndexer.getAnchorsBySchema`) rather than the lens-scoped
    `getAnchorsBySchemaAndAddressList`. Because `props.set` reuses a "first-writer-wins"
    key-ANCHOR, a lens attester can bind an active value to a key whose anchor a
    _different_ attester minted first. The old enumeration was scoped to the binding
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
- 910dcfe: Two fixes: (1) `efs.props.list` bounds its key-ANCHOR enumeration. Key anchors are attester-independent and non-revocable, so any account can permanently append PROPERTY-bucket anchors under someone else's DATA — trusting the raw count let a third party make this public read consume unbounded memory and RPC (an EAS read plus a value read per row). The scan is now capped at `MAX_PROPERTY_SCAN` (1024 raw rows), with a per-call `maxKeys` option to bound it further; the index is append-ordered, so a DATA's genuine earlier-minted keys are the ones retained. (2) List reads keep the FULL ranked lens-candidate set instead of pre-filtering it with a `length` probe — a candidate that was empty at probe time but gains an entry before the follow-up read is now reachable (it had been dropped for the whole request, and permanently for a memoizing `entries()` handle). Every verb already checks liveness as it walks, so removing the probe also removes one read per candidate.
- 820a9e5: `props.list`'s key-scan budget now clamps the window LENGTH, not just the page starts. `maxKeys: 10` previously still requested a full 256-row window (and decoded + value-read all of it), and `maxKeys: 300` processed 512 — defeating the caller-controlled anti-griefing bound the option documents. The final window now asks for exactly the remaining budget.
- 4322508: The fetch engine's `web3://` attempt now RACES the reader promise against the per-attempt abort signal: the in-reader signal checks run between chunk RPCs, so a single `readContract`/`getCode` on a transport with no timeout of its own could still hold the await open past `timeoutMs` and block mirror failover indefinitely. The attempt now settles when the timer fires (the orphaned RPC keeps running without an abortable transport — documented — but failover proceeds and its eventual rejection is swallowed).
- de84c15: The redirect engine now implements the RATIFIED resolution algorithm (contracts specs/09 / ADR-0067), replacing the provisional pre-spec follower. BREAKING behavior vs the unreleased scaffold: **only `symlink` (2) navigates** — `followRedirects` now means ANCHOR-sourced symlink following during path resolution (each landed anchor's lens-visible chain, same lens scope, a fresh `D_MAX` budget per landed anchor — the §8 reference algorithm's per-re-entry counter); `sameAs` and `supersededBy` are NON-followed terminals, so an exact DATA UID never silently advances ("no silent revision": path = newest, UID = exact). The DATA→DATA post-placement walk is deleted. Non-`Resolved` outcomes are DATA, not throws: walks surface a node with `Resolved`/`Dangling`/`CycleStopped`/`DepthExceeded` (`RedirectWalkStatus`), and reads map them to the 404-equivalent (`locate` → `null`) — the `RedirectCycle`/`RedirectHopLimit` error classes and codes are REMOVED. Defaults move to the ratified numbers: `followRedirects: true` = `D_MAX 16` (was 8), hard ceiling 32. Selection is conformant: first-attester-wins by lens order with LOWEST-redirect-UID ties (was newest-first), no fall-through past a trusted attester's non-navigational winner, and pagination over the indexer's PHYSICAL windows — fixing the bug where a revoked newest record faked an absence and let a lower-priority lens member's redirect win. The other two redirect meanings become explicit verbs: `redirects.list` (raw discovery), `redirects.canonical` (`sameAs` SCC → lowest-UID representative, entry-independent), `redirects.history` (deliberate `supersededBy` breadcrumb walk with `latest`/`chain`/`complete`) — all lens-scoped, wallet-free, and exposed on the read-only client. New exports: `selectLensRedirect`/`listLensRedirects`/`walkSymlinks`/`canonicalizeSameAs`/`walkSupersededBy`/`isNavigationalKind` (replacing `readActiveRedirect`/`followRedirectChain`/`isAutoFollowedKind`/`REDIRECT_FOLLOW_MAX_KIND`). The spec §9 conformance vectors are the test suite, driven through a mock that models `_sliceUIDsFiltered`'s within-window filtering faithfully.
- 83a86c2: `?format=raw` (IPIP-402) now rides only on bare RAW-block IPFS CIDs, not on every `ipfs://` locator. For a raw-codec (`0x55`) CID the block IS the file's bytes, but for dag-pb/UnixFS — every CIDv0 `Qm…` and the `bafybei…` CIDv1s — the raw block is a protobuf node wrapping the payload (links only, for a multi-block file). Forcing raw asked compliant gateways for that wrapper, so the fetch engine re-hashed the block instead of the content: a perfectly valid IPFS mirror read back as `verification: 'mismatch'` and `readBytes`/`readText` threw. Subpaths (`ipfs://<cid>/dir/a.txt`) are UnixFS directory walks and never qualify either. The check is conservative — anything not provably a raw block skips the parameter and takes the gateway's normal file response, since the cost of guessing wrong is a file that never reads while the cost of omitting the hint is nil. Gateways remain untrusted regardless: every byte is still re-hashed against the attested `contentHash`.
- 164c09b: Three review fixes: (1) `buildRawContracts` is now overloaded on the wallet — building without a wallet client returns `EfsRawReadContracts` (no `.write.*` surface at the type level), so a no-wallet consumer can no longer type-check `raw.eas.write.revoke(...)` that was a runtime `TypeError`; the wallet may now also be omitted entirely instead of passing `wallet: undefined`. (2) `efs.props.set` routes its key-anchor planning read through the chain-guarded read client like every other planner, closing a provider-drift window that could feed a wrong-chain key-anchor UID into the plan (partial write: PROPERTY mines, binding PIN reverts). (3) The content-hash spec and `FetchOptions.maxBytes` docs now describe the real declared-size contract: the author's `size` claim is a POST-fetch consistency check (`mismatch`), never a transport cap — a small claim does not shrink the allocation bound; set `maxBytes` for that.
- 3227866: Extend the live-chain safety to the `efs.raw.*` escape hatch:

  - **Raw writes are guarded regardless of a bound account.** viem raw writes accept a
    per-call `account`, so an unbound wallet on a different chain could call
    `efs.raw.*.write.*(args, { account })` and broadcast to the wrong chain — the previous
    guard skipped the chain check when no account was bound. The raw-write proxy now runs the
    chain assertion unconditionally (the bound-account early-return remains only on the
    higher-level write verbs, which derive the attester from the bound account).
  - **Raw reads are guarded against a drifted provider.** The raw contract instances are
    bound to the construction-time deployment addresses; a mutable provider that switches
    networks would read those addresses on the new chain. The public client handed to the raw
    instances now validates the live chain matches the deployment before each `readContract`,
    failing closed with `WrongChain` rather than returning wrong-chain data.

- 5e82ba3: Three review fixes: the raw namespace's type gate is now real — `EfsRawReadNs` uses new read-only contract instantiations (`EfsRawReadContracts`, no `.write.*` at the type level), so a no-wallet client can no longer type-check `raw.eas.write.revoke(...)` that was a runtime `TypeError` (`EfsRawNs` keeps the wallet-backed surface). Browser `opaqueredirect` responses now FAIL the attempt instead of being followed unchecked — the destination is uninspectable, so none of the per-hop SSRF/private-host/downgrade guards can run, and CORS gates response reading, not whether the redirected request reaches a private-network endpoint (supersedes the earlier followed-URL provenance behavior; failover to a direct mirror proceeds). And the raw-SSTORE2 fallback re-checks the abort signal before its `getCode` — an abort during the pending `chunkCount` no longer starts more RPC work.
- 23ef14c: Two read-path fixes:

  - **(P1) An author-declared `size` can no longer raise the fetch cap.** On the default
    `read()`/`readText()` (no `opts.maxBytes`), `opts.maxBytes ?? declaredSize` made a large
    declared `size` the engine cap, so an untrusted attester claiming e.g. 1 GB bypassed the
    documented 50 MB default and could force buffering before verification/failure. The
    declared size now only LOWERS the cap (caller `maxBytes` if set, else the engine default;
    clamped down by `declaredSize`), never raises it.
  - **(P2) `read` byte-fetch options now forward an abort `signal`.** `FetchOptions` gains
    `signal?: AbortSignal`, threaded into the mirror engine, so a caller (e.g. an aborted
    server request) can cancel a slow mirror read promptly instead of waiting out the
    per-attempt timeout.

- 6294bdc: fix(reads): fail closed on cross-chain DataRefs; enforce the byte cap while reading web3:// chunks

  - **Cross-chain `DataRef`** — `fetchRef` now throws `WrongChain` when `ref.chainId`
    differs from the connected deployment's chain. EAS UIDs and `web3://` mirrors are not
    chain-qualified, so reusing a ref from another chain would have silently resolved a
    different deployment's mirrors/properties; it now fails closed before any read.
  - **web3:// byte cap** — the `maxBytes` cap is threaded into the web3 reader, which now
    stops and throws as soon as the running chunk total exceeds it. Previously the bundled
    `readWeb3Bytes` accumulated every chunk (up to the ~96 MB scan cap) before the post-hoc
    size check, so an attacker-controlled on-chain mirror could force RPC work + allocation
    far beyond the configured cap. The post-read check stays as defense in depth.

  Also corrected the `followRedirects` docs: only the DATA-sourced `sameAs`/`supersededBy`
  kinds are followed today. `symlink` is ANCHOR-sourced (a path alias), so path-level
  symlink resolution is deferred pending the ADR-0050 resolution-spec pin (the docs
  previously implied `symlink` was auto-followed).

- d042767: fix(reads): resolve file leaves from the DATA anchor slot; trust attested contentType + size

  - **File-leaf resolution (P1 — read-side of the file-anchor fix).** `locate`/`read`/`info`/
    `exists` walked the WHOLE path generically (`resolvePath`/`forSchema=0`), but the SDK now
    writes file anchors at `(parent, name, DATA_SCHEMA_UID)` — so SDK-written files read as
    ABSENT. New `resolveFilePathToAnchor` walks parent folders generically, then resolves the
    terminal file segment via `resolveAnchor(parent, name, DATA_SCHEMA_UID)` with a generic
    fallback (legacy anchors / router parity, EFSRouter.sol:240-245).
  - **Attested `contentType` (P2).** `EfsFile.contentType` now comes from the author's reserved
    `contentType` PROPERTY (lens-scoped), never the untrusted transport `Content-Type` header a
    gateway can change independently of the attestation.
  - **Enforce attested `size` (P2).** The fetch is capped at the author's declared `size`
    PROPERTY, so a mirror body exceeding it is rejected during the fetch instead of returning as
    `matches-author` / forcing over-buffering.

- 2b834be: The readability proof extends to the last two placement surfaces: (1) `efs.graph.pins.place` now requires at least one ACTIVE mirror authored by the connected account on the target DATA before submitting (its plan is `hardlink: false`, so the layered submitter's hardlink proof didn't cover it) — a bare or all-revoked-mirror DATA refuses with guidance instead of confirming a placement whose every `read()` fails `AllMirrorsFailedError`. (2) Solidity `placeExisting` and `place` take the indexer (the thin `IEFSIndexerWrite` interface gains the two referencing-read getters) and revert the new `NoActiveMirror(dataUID, author)` unless the placer has an active MIRROR on the target — ownership proves who minted the DATA, not that the hardlink shortcut has metadata to reuse. Both scans walk raw-count-bounded filtered windows with first-hit exit (one count read plus one window in the healthy case).
- 14332d1: README accuracy: `fs.overview`/`setOverview` and `list({ excludes })` are implemented (they were still listed as "coming"), `efs.sorts` is added to the not-yet-implemented list, and the README now states the practical write limits on Sepolia (on-chain storage size, several confirmations per file) and how files carrying a pre-ADR-0016 bare-digest `contentHash` read back. Also corrects the Sepolia registry note: writes resolve `/transports/<scheme>` on-chain, so no `transportDefinition` is needed.
- 1889c88: Two cross-chain safety fixes for clients built on a mutable EIP-1193 provider:

  - **Reads now resolve the deployment from the LIVE provider chain** (`eth_chainId`), not
    the construction-time `publicClient.chain.id`. If an injected wallet switches networks
    after the client is built, `readContract` goes to the provider's current chain — so
    resolving from the bound chain would query the old deployment's addresses on the new
    chain (false misses / wrong-chain data). `fs.read`/`info`/`list`/`locate`/`exists`/
    `overview`, the `props`/`redirects`/`lists` read paths, and `raw.verifyDeployment` now
    re-resolve from the live chain (so a switch is reflected, or surfaces `DeploymentNotFound`).
  - **`efs.raw.*.write.*` is now guarded against a wrong-chain wallet.** The raw escape-hatch
    contract instances called `walletClient.writeContract` directly, bypassing the
    `WrongChain` preflight the higher-level write verbs run. The wallet handed to the raw
    instances is now wrapped so every write asserts the live wallet chain matches the
    deployment first.

- e1093db: Two boundary-gate corrections: (1) the unconditional DATA-bucket check at the layered boundary is now ACTUALLY in place — the previous changeset claimed it, but the edit script had crashed before writing and the `pins.place` inline gate masked the gap in tests; the review caught it. Every reused/definition anchor's `(name, forSchema)` payload is decoded and checked against the plan's expected bucket regardless of slot stamps, with the expected bucket now generalized via `existingAnchorForSchema` (files: DATA; property bindings: PROPERTY). (2) `buildPropertyPlan`'s reuse branch stamps the requested `(dataUID, key, PROPERTY)` slot, so the exported-builder path through `submitEdgePlan` verifies a reused key-anchor actually names that slot before layer 1 broadcasts — an unrelated anchor previously bound the fresh PROPERTY at a definition `props.get(dataUID, key)` never resolves.
- 45b8906: Two public type-surface fixes:

  - **`WriteReceipt.steps[].uid` is now `Hex`, not `DataUID`.** Steps record every minted
    attestation (file-ANCHOR, MIRROR, PROPERTY, placement-PIN, TAG, LIST_ENTRY, REDIRECT,
    DATA, …), so branding them all as `DataUID` let placement/property/anchor UIDs be passed
    where a file-content identity is required — defeating the wrong-UID-kind guard the brand
    exists for. The file's content identity remains `receipt.data.uid` (`DataUID`); a step's
    kind is conveyed by its `id`.
  - **`ExpandToken` no longer includes `'mirrors'`/`'redirects'`.** Those tokens were in the
    public union but never hydrated (no result field, no read-path handling), so
    `info(path, { expand: ['mirrors'] })` silently no-opped. They are removed until
    implemented (added back additively when a verb hydrates them); read mirrors via
    `efs.mirrors.list(...)` and redirects via `followRedirects`/`ReadResult.via` meanwhile.

- 884b637: Re-assert the live chain before EVERY wallet transaction in a multi-tx write, not just
  once at preflight. A single logical write fires many wallet confirmations — the two
  on-chain storage deploys (chunk + manager) and one `multiAttest` per dependent DAG layer.
  An injected wallet can switch networks between any two prompts; the old single preflight
  let a later step broadcast to the new chain while receipts were still awaited on the
  deployment chain, leaving a wasted/orphaned deploy or a partial attestation write.

  - `submitLayeredTier1` now runs the chain guard before each layer's `multiAttest` (threaded
    through `SubmitContext.assertChain`), so the file write, `setOverview`, and the standalone
    edge/value writes (`graph.tags`/`graph.pins`/`props`) all fail closed with `WrongChain` on
    the dependent layer rather than sending it to the wrong chain.
  - `storeOnchain` re-checks before the chunk deploy AND between the chunk and manager deploys
    (`OnchainStoreContext.assertChain`), so a switch after the chunk lands stops the manager.

  The standalone edge writes drop their now-redundant single preflight — the per-layer guard
  covers the first layer too.

- aeb22dc: `parseWeb3Uri` now redacts before truncating the URI it rejects. It is a public export, so its argument is arbitrary — and both error paths sliced the head of the raw string, meaning `https://alice:hunter2@…` printed `https://alice:hu`. Summarizing first keeps the messages short while stripping userinfo and inline `data:` bodies. Found by sweeping for the pattern behind the wrapped-parser-error leak rather than waiting for it to be reported; severity is lower than the mirror-URI leaks (the string is the caller's own, not one read from the chain), but it was the last unredacted URI-in-error site in the package.
- 3e61caa: Credential redaction now follows WHATWG's delimiter rule and strips through the FINAL `@` of the authority.

  A raw `@` is legal inside a password, and WHATWG URL parsing treats the last `@` before `/`, `?` or `#` as the userinfo delimiter — so `https://alice:p@ss@example.com/file` parses with password `p@ss`. The previous redaction stopped at the first `@` and emitted `https://<credentials redacted>@ss@example.com/file`, leaking part of the credential into preflight errors, read errors for previously minted mirrors, and anything downstream that records them. An `@` appearing in a path, query or fragment is still left untouched.

- 94a67b6: Mirror-URI validation errors no longer reintroduce the raw URI when wrapping a parser failure.

  `UnsupportedUriError` redacts what it prints, but the write preflight caught it and rebuilt a higher-level message from the original string — so a credential-bearing URL leaked its password one layer up, and a malformed `data:` URI leaked its inline payload, into any log or telemetry recording the error. Four wrapper sites shared this shape (the IPFS-CID, `web3:`, generic known-scheme, and `efs.mirrors.add` scheme-prefix errors); all now route the URI through `summarizeUri`.

- 64f36e8: > **Superseded in the same release** by the ratified-redirect-resolution change: the provisional follower described below (sameAs/supersededBy following, 8-hop default, `RedirectCycle`/`RedirectHopLimit` throws, `readActiveRedirect`/`followRedirectChain` exports) never shipped — specs/09 was ratified first. The namespace + write plan + `via` provenance described here survive; the resolution semantics and exports are the ratified ones.

  Add REDIRECT (alias) support — the last unbuilt frozen schema (ADR-0050). REDIRECT is the trust-scoped "this points at that" primitive: canonical/dedup-resolution for duplicate DATA (`sameAs`), version supersession (`supersededBy`), and path symlinks (`symlink`). The schema is `"bytes32 target, uint16 kind"`, revocable, with the SOURCE in `refUID` and `(target, kind)` in the payload; only the field string is frozen — the `kind` taxonomy (`0=sameAs / 1=supersededBy / 2=symlink / 3+=reserved`) is upgradeable SDK convention, not part of the UID.

  - **Read-time resolution (the main value-add).** `AliasResolver` is write-time-guards-only (no self-loop, per-kind endpoint typing) and `EFSRouter` reads only the DATA-pin slot, so following an alias is the SDK's job. `efs.fs.locate`/`read`/`info` accept `{ followRedirects?: boolean | number }` — **off by default** (a redirect reroutes file _identity_ with a larger blast radius than a PIN, and ADR-0050's normative resolution spec is not yet pinned). `true` follows auto-followable kinds (`sameAs`/`supersededBy`/`symlink`; `relatedVersion`/`kind>=3` never) up to the default 8-hop cap (`D_MAX`); a number sets an explicit cap (≤ 32). The result surfaces the alias chain via `ReadResult.via` (`via[0].from` is the originally-requested identity — "never silently teleport"). Cycle detection throws `RedirectCycle`; over-cap throws `RedirectHopLimit` (both fail-closed). The active redirect from a source is discovered lens-scoped (first-attester-wins, revoked-excluded) via `EFSIndexer.getReferencingBySchemaAndAttester(source, REDIRECT_SCHEMA_UID, attester, …)`.
  - **Write/read verbs (`efs.redirects.*`).** `set(from, to, { kind? })` authors a `REDIRECT(refUID = from, data = (to, kind))` as the connected wallet (one signature; `kind` defaults to `sameAs`); REDIRECT is not cardinality-1, so `set` does not auto-supersede a prior redirect — endpoint typing is enforced on-chain and surfaces as a typed `ContractReverted`. `remove(redirectUID)` revokes via `efs.eas.revoke`. `get(from, { lens })` returns the literal active `RedirectRecord` (any kind, not chain-followed). Type-gated like `graph`/`props` (write verbs present only on a write-capable client).

  New exports: the `efs.redirects` namespace, `buildRedirectPlan`, `REDIRECT_KIND`, the `reads/redirects` engine (`readActiveRedirect`/`followRedirectChain`/`resolveHopCap`), the `RedirectKind`/`RedirectRecord` types, and the `RedirectCycle`/`RedirectHopLimit` errors.

  NOT yet implemented (deferred with the protocol's normative resolution spec, not guessed): ADR-0050's **cycle = lowest-UID-in-SCC** canonicalization (the SDK fails closed on a cycle rather than guessing the unpinned SCC algorithm) and path-level **symlink** following before placement (anchor→anchor resolution ahead of the pin read). Today's following is DATA→DATA `sameAs`/`supersededBy` from the resolved placement, which is the unambiguous dedup/versioning case.

- f7e400f: Three closures: (1) `buildRedirectPlan` stamps symlink plans with `symlinkTargetUID`, and the layered boundary re-runs the direct-DATA readability proof — the exported builder + `submitEdgePlan` pair could previously author the unreadable symlink the namespace verb refuses. (2) Solidity `setRedirect` applies the same gate: a `symlink` whose target attests as DATA requires the author's own active mirror (`NoActiveMirror`) before the atomic attest+index; ANCHOR targets are unaffected. (3) The exported `resolveTransport` now applies `DEFAULT_MAX_BYTES` when `maxBytes` is omitted — a direct caller's untrusted `data:` URI could previously materialize an arbitrarily large payload since `resolveData`'s cap checks were all conditional; only `fetchVerified` callers got the 50 MB default.
- 23970ea: REDIRECT writes now complete the EFSIndexer indexing lifecycle (ADR-0017), fixing the P1 where a `redirects.set()` was INVISIBLE to `redirects.get()`/`fs.locate` (AliasResolver never populates the referencing index the reads use) and a `remove()`d redirect kept being SERVED (filtered reads key on the indexer's revocation mirror, not EAS state). `set()` sends a follow-up permissionless `EFSIndexer.index(uid)` tx by default (an `index` step on the receipt; the extra prompt is counted honestly); `remove()` waits for the revoke to mine, then sends `indexRevocation(uid)`, and now returns a two-leg `RedirectRemoveReceipt { revokeTx, indexRevocationTx }` (BREAKING vs the unreleased scaffold: was a bare `Hex`). A failed index leg after the attest/revoke landed throws the typed recoverable `IndexingIncomplete` (new error, code `PartialBatchFailure`) carrying the landed UID — repaired by the new public verb `efs.index(uid)`, which reads EAS + `isIndexed`/`isRevoked` and idempotently sends whichever leg is missing; it is lens-neutral (never changes the attester), so any funded account may run it. `{ index: false }` opts out on both verbs for relayer/batch flows. The resolver sweep is recorded in ADR-0017: REDIRECT is the ONLY SDK-written schema with this gap (TAG/PIN/MIRROR/ANCHOR/DATA/PROPERTY auto-index in their resolvers; LIST reads use ListReader storage). A real-indexer fork test (`set → get → remove → get(undefined)`) is the regression; unit mocks now model the lifecycle honestly. New vendored ABI fragments: `index`, `indexBatch`, `indexRevocation`, `isIndexed`.
- ac5c5fe: Two follow-on hardening fixes: (1) redirect selection now decodes an attester's candidates in ascending-UID order until one survives the EAS revocation recheck — previously only the preselected lowest UID was decoded, so a revoke racing between the scan and the decode made the selection fall through to a lower-priority attester even though the winning attester still asserted other active redirects (breaking first-attester-wins). (2) The on-chain storage path gets the same refusal-vs-transport send split as the layered submitter: when the chunk-manager deploy's send fails WITHOUT a response, `OnchainStoreIncomplete` now carries `managerBroadcastUnknown: true` and its message says the deploy may still mine and to check the account's pending txs/nonce before re-wrapping — instead of confidently asserting the manager was never broadcast and recommending an immediate (possibly duplicate) re-wrap. Pre-send guard failures (abort, chain drift) remain definite.
- 9e9ddca: Redirect reads recheck revocation at the EAS decode: the active-only indexer scan and the follow-up `getAttestation` are two reads, so a revoke landing between them was still honored for one more read by `redirects.get`/`list`, canonicalization, history, and the symlink walk. The shared record fetch now reads `revocationTime` in the same lookup and discards a retracted redirect as absence.
- e00aa8b: The padded multibase codes (`c` base32pad, `C`, `t` base32hexpad, `T`) are now refused by name at the write preflight instead of being decoded with the ordinary unpadded routine. Swapping a valid base32 CID's `b` prefix for `c` spells base32pad WITHOUT the `=` padding multibase requires, and it passed the preflight — so it could be minted as a file's only mirror while strict multibase/IPFS implementations reject the locator outright. Parsing the padding instead would not help: `=` is non-alphanumeric, and the `ipfs://` reader refuses those characters so a crafted CID cannot smuggle path or host characters into a gateway URL, which means a correctly padded CID could never be read back either. The error names the base and tells the caller to re-encode as base32 (`b…`) or base58btc (`z…`), rather than reporting an "unknown" prefix for a code that is genuinely assigned.
- 25ba352: HTTP(S) mirror URLs carrying embedded credentials are now rejected at parse, and any credentials that do appear are redacted from error and attempt output.

  `new URL()` accepts `https://user:pass@host/…`, so such a URL passed the write preflight — but WHATWG `fetch` refuses to construct a Request from a URL with credentials and throws before any network call, so the mirror would confirm on-chain and then fail every read with `AllMirrorsFailedError`.

  The redaction is a separate concern and applies regardless: `summarizeUri` is what every error and attempt record flows through, and it previously copied the userinfo component verbatim — including into the new refusal's own message. The chain is append-only, so a credential-bearing mirror minted before this guard still reaches readers, and its secret should not land in logs. Redaction targets only the userinfo component; an `@` in a path or query string is left alone.

- 60b528b: `fs.write` now rejects an explicitly empty `mirrors` list (`mirrors: []`) with a typed
  `InvalidArgument` error instead of falling through to on-chain auto-storage. Supplying
  `mirrors` means the bytes already live off-chain and the SDK will not store them, so an
  empty list is a caller error (e.g. an optional mirror list that resolved to empty) — the
  old fall-through could silently spend gas and publish bytes on-chain. Pass at least one
  URI, or omit `mirrors` to opt into on-chain storage.
- 72f7467: The bit-packed multibase decoders (the base2/base8/base16/base32 families) now reject a body that carries more bits than the bytes it spells, instead of silently dropping the trailing partial byte. Appending one hex nibble to a valid base16 CID — or one character to a valid base32 CID — produced the SAME decoded bytes and cleared every structural CID check, so the malformed locator could be minted as a file's only mirror and then 404 at a strict IPFS gateway: a write that confirms and can never be read. RFC 4648 leaves at most `bits - 1` padding bits and they are zero; anything more is now refused. Valid CIDv0/CIDv1 locators in every multibase the table decodes are unaffected.
- c318c82: `fs.write` and `efs.mirrors.add` now reject a mirror URI over MirrorResolver's 8192-byte
  limit (`MAX_URI_LENGTH`) before submitting, alongside the existing empty-URI guard. An
  oversized URI reverts at the MIRROR layer — and in `fs.write` that revert lands after the
  L1 DATA attestation has already mined, orphaning a partial write — so both paths now
  preflight the UTF-8 byte length (MirrorResolver checks `bytes(uri).length`, not the JS
  string length) and throw a typed `InvalidArgument`. The empty/oversized checks are unified
  in a shared `validateMirrorUri` helper.
- a17c78f: > **Option renamed in the same release**: the write-side option is now `author` (the v1-profile change — a lens is reader policy; the write-side identity is the author). The guard semantics below are unchanged under the new name.

  `fs.write`/`fs.setOverview` now reject a `lens` other than the connected account with a
  typed `NotImplemented` error instead of silently ignoring it. The Tier-1 write path always
  attests as the wallet account (EFS lenses key on the attester), so a foreign `opts.lens`
  was accepted but never honored — the file was authored under the wallet lens, invisible to
  reads/lists through the requested lens, with no signal to the caller. Until delegated/
  foreign-lens writes land, a mismatched lens fails fast; passing the connected account (or
  omitting `lens`) is unchanged.

- b038ec9: Mirror URIs with leading or trailing whitespace are now rejected at the write preflight. The known-scheme parse is anchored, so `" https://cdn.example/file"` matched no scheme, fell out of the known-scheme branch entirely, and was minted as a "custom" transport — bypassing the structural checks its scheme should have received. At read time `resolveTransport` then rejected the unchanged string for having no scheme, leaving an only-mirror that can never be read. Rejected rather than trimmed: the chain stores the URI verbatim, so silently rewriting it would mint a locator the caller never wrote.
- 126dc15: Mirror URIs must now start with a syntactically valid `scheme:` prefix, and URI validation errors no longer echo inline `data:` payloads.

  A locator like `"https ://cdn.example/file"` carries no surrounding whitespace but parses as schemeless because of the space before the colon. With an explicit transport anchor supplied, the transport lookup returned before any scheme check, so it was minted as a "custom" transport and then rejected at read time by `resolveTransport` — an only-mirror that can never be read. The preflight now requires a scheme on every locator (`MissingTransport`, the same code and message shape the schemeless path already used; what changed is its reach). This is not a scheme allowlist — ADR-0056's custom-scheme escape hatch is untouched — but an explicit `transportDefinition` no longer substitutes for a scheme, because the reader parses the scheme off the URI itself. The preflight also now shares `uriScheme` with the reader instead of keeping its own copy of the pattern, which is how the two drifted apart.

  Separately, the whitespace-rejection error interpolated the full URI, which for a `data:` mirror means inline file content — and that check runs before the length cap, so up to 8 KiB of payload could reach logs and telemetry. It now uses the same `summarizeUri` redaction the transport layer applies, on the trimmed string (leading whitespace defeats `summarizeUri`'s `data:` detection and would otherwise still leak the first 200 characters).

- 3f01435: Two fixes: (1) when a bound cursor's attester turns out empty, list pagination now restarts the ranked scan from the TOP instead of only advancing past that attester — a higher-ranked candidate that gained entries while the cursor was held must win, and previously a bound cursor on the last-ranked candidate reported end-of-list. (2) `edgeSubmitContext` now supplies the chain-guarded public client, so the submitter's boundary gates (hardlink authorship/schema, reused anchor, symlink readability, transport anchors) can no longer approve a plan against state read from a drifted chain — matching what the file-write planner already did.
- 7318424: List pagination's evaporated-leader failover now covers RESUMED cursors: an empty page at a nonzero offset is disambiguated with a live `length` read — a standing leader's empty page stays the honest end of pagination, while an evaporated leader (entries revoked after the selection probe) falls through to the next ranked lens candidate, restarting at offset 0 since the persisted cursor indexed the evaporated attester's listing. Previously the failover was restricted to offset zero, so a resumed listing could report a false end while a lower-priority attester held entries.
- 0a541b5: Fix two write-path correctness bugs where the SDK re-minted a permanent, non-revocable ANCHOR for a slot that already existed — reverting (`DuplicateFileName`) or mis-binding instead of superseding via the cardinality-1 PIN.

  - **Overwrite reuses the file anchor (Bug 1).** `efs.fs.write` / `efs.fs.setOverview` to a path whose DATA-typed file anchor already exists no longer mints a fresh file-ANCHOR for the same `(parent, fileName, schemas.data)` slot. `writeFileTier1` now probes for the existing anchor (`resolveAnchor(parentAnchorUID, fileName, schemas.data)`, only when the parent already exists — a `mkdir -p` leaf can't pre-exist) and threads an optional `existingFileAnchorUID` into `buildFileWriteGraph`. When present the graph emits NO file-ANCHOR and points the placement PIN's `definition` (and any Overview `system` TAG's `refUID`) at the concrete existing UID; when absent it mints the DATA-typed file anchor exactly as before. The cardinality-1 placement PIN supersedes the prior content. The reserved-key triples + DATA + MIRRORs are still minted fresh (new content). A second `setOverview` on the same folder now succeeds.

  - **`props.set` reuses the key anchor (Bug 2).** `efs.props.set(dataUID, key, value)` on an existing key no longer mints another key-ANCHOR for `(dataUID, key, PROPERTY_SCHEMA_UID)`. `set` resolves the existing key anchor first (`resolveAnchor`); when it exists, `buildPropertyPlan` builds only the fresh PROPERTY + a binding-PIN whose `definition` is the concrete existing key-anchor (mirroring Solidity `EFSLib.setPropertyAt`), so the read path (`resolveAnchor(dataUID, key, PROPERTY_SCHEMA_UID)`) sees the updated value. A new key still emits the full key-ANCHOR + PROPERTY + binding-PIN triple.

  Encodings are unchanged (verified against the deployed contracts); only standalone `props.set` and the file-ANCHOR overwrite gained the reuse logic. No public API changes; no bundle-size-relevant hot-path additions.

- 971cfdf: On-chain (zero-infra) writes now deploy the productionized **ERC-5219 `EFSBytesStore`**
  instead of the old `MockChunkedFile`, so a bare `web3://<store>` URL for any
  SDK-uploaded file resolves in any EIP-4804/6860/5219 client — not just via the EFS
  router/SDK.

  - Re-vendored `EFS_BYTES_STORE_BYTECODE` from the merged contracts artifact (solc 0.8.26,
    viaIR; validated by the contracts' 20 `EFSBytesStore` deploy tests).
  - The deploy now uses the 2-arg constructor `EFSBytesStore(address[] chunks, string
contentType_)`; the SDK threads the file's MIME (the same value bound as the
    lens-scoped `contentType` PROPERTY; empty ⇒ `application/octet-stream`) into the store.
  - The on-chain reader (`mirror/web3.ts`) is unchanged — it keeps the direct
    `chunkCount`/`chunkAddress` + extcodecopy path for byte-for-byte parity with
    `EFSRouter.sol` (ADR-0013). No public TypeScript API change.

- 269330b: Two fixes:

  - **The wrong-chain write guard now covers revokes/removes.** `graph.tags.remove`,
    `graph.pins.unplace`, `mirrors.remove`, `redirects.remove`, `lists.remove`, and the raw
    `efs.eas.attest`/`multiAttest`/`revoke` escape hatch all route through `makeEasVerbs`,
    which previously bypassed the chain assertion added for the add/set/create paths — so a
    wallet on a different chain than the deployment could send a no-op/wrong-chain EAS revoke
    while the real attestation stayed active. `makeEasVerbs` now runs the same fail-closed
    `WrongChain` preflight before every write tx.
  - **`web3://` reads accept router-valid mixed-case addresses.** A mirror address with
    arbitrary mixed-case hex but no valid EIP-55 checksum (legal for the router, which parses
    case-insensitively) made `parseWeb3Uri` throw `InvalidAddress` from `getAddress`, failing
    reads when it was the only mirror. The hex is now lowercased before checksumming.

- e341daa: `redirects.canonical()`'s `MAX_SAMEAS_NODES` budget is now enforced when targets are DISCOVERED, not just before fetching the next node. Previously each of the 256 fetched nodes could queue up to 512 targets, all of which the leaf-backfill step then inserted into the Tarjan graph — so a crafted `sameAs` graph could push roughly 131,000 nodes through the SCC pass despite the documented 256-node cap. Edges whose target cannot be admitted are dropped and reported through the existing `complete: false`, keeping the explored graph within the budget.
- e318ca6: Implement the schema-UID integrity assertion — the deployment trust gate that was a TODO and a flagged 1.0 blocker (review P1 #9, ADR-0005).

  `assertDeploymentIntegrity` only checked that each contract address has _some_ bytecode, so a wrong/hostile `deployments` override passed as long as the addresses were contracts — the read model's trust root was unverified. Now there is a real gate:

  - **`assertSchemaIntegrity(publicClient, deployment)`** reads each of the nine frozen schema UIDs from its **authoritative** on-chain getter and asserts it matches `deployment.schemas`. Sources (ADR-0048): `anchor`/`property`/`data`/`pin`/`tag`/`mirror` → `Indexer.*_SCHEMA_UID()`; `list` → `ListResolver.listSchemaUID()`; `listEntry` → `ListEntryResolver.listEntrySchemaUID()`; `redirect` → `AliasResolver.redirectSchemaUID()` — the three self-derived UIDs hash in their own resolver's address, so a hostile contract set can't forge them. The nine reads are batched via `Promise.all` (one `eth_call` each; viem folds them into a multicall where supported). On any mismatch it throws `SchemaMismatchError` with a precise diff (which schema, claimed vs on-chain UID, source getter), listing every mismatch — not just the first. UID comparison is value-based (tolerant of casing + leading-zero width).
  - **`verifyDeployment(publicClient, deployment)`** chains both gates: bytecode presence first (clearer error for a typo'd address), then schema authenticity.
  - **`efs.raw.verifyDeployment()`** now runs the full `verifyDeployment` gate. It stays **opt-in** (ADR-0005): the client does not run it on every construct (no mandatory RPC round-trip), and callers wiring a custom `deployments` override are advised to run it once.

  New exports: `assertSchemaIntegrity`, `verifyDeployment`.

- 87642ab: Seed the shared community **devnet** (chainId `26001993`) in the built-in deployments
  registry. The devnet is a Sepolia fork (contracts ADR-0062), so its contract addresses and
  the 9 schema UIDs are byte-identical to Sepolia — CREATE/CREATE2 and EAS schema UIDs are
  chain-id-independent, only the network identity differs. Devs can now point a viem client
  at the devnet RPC and the SDK resolves the deployment automatically (no `deployments`
  override), giving a frictionless place to try EFS without burdening Sepolia or running a
  local node. The Sepolia entry is unchanged.
- 650556b: feat(chain): seed the live Sepolia (11155111) deployment in the built-in registry

  The built-in registry was empty, so `createEfsClient({ provider, chain: sepolia })` threw
  `DeploymentNotFound` even though Sepolia froze on 2026-06-19. Seeded the canonical addresses

  - nine frozen schema UIDs from the contracts repo `docs/CHAINS.md` (EFSIndexer/EdgeResolver/
    MirrorResolver/ListResolver/ListEntryResolver/AliasResolver/SystemAccount proxies +
    EFSFileView/EFSRouter/ListReader views + EAS/SchemaRegistry). `resolveDeployment(11155111)`
    now returns it (regression-tested); reads work out of the box.

  `transports` is intentionally omitted — the per-scheme `/transports/<scheme>` anchor UIDs are
  runtime EAS UIDs not derivable offline and not in `docs/CHAINS.md` (only the `/transports`
  root is). A default on-chain (`web3://`) write therefore needs `WriteOptions.transportDefinition`
  until those are seeded; everything else works.

- 41a0d6b: The mirror-readability gate every write path runs before minting a placement, symlink or hardlink is now one shared predicate (`hasActiveMirror`). The check had been re-derived at five call sites and the copies drifted: after the reader moved to scanning the newest `MAX_MIRRORS` slots, some gates were still scanning raw slots `[0, 500)`, so a caller with a fresh mirror past slot 500 was refused a write the reader and the router could both serve — while a mirror stranded below the readable window was accepted, producing a placement that confirms and then fails every read with `AllMirrorsFailed`. A gate that disagrees with the reader is worse than no gate. The shared predicate also reads UIDs rather than decoded rows and exits on the first hit, so the healthy case costs one count read plus one window.
- fc191a0: `WriteReceipt.signatureCount` now reports the HONEST wallet-confirmation count on the
  default `fs.write(path, bytes)` path. Previously it counted only the EAS attestation
  layers and omitted the two on-chain storage deploys (the SSTORE2 chunk + the
  `EFSBytesStore` manager) that `resolveMirrors` sends first — so UIs and accounting/retry
  flows under-reported the default write by two signatures. `storeOnchain` now returns its
  transaction hashes, `resolveMirrors` surfaces a `storageTxCount`, and the orchestrator
  folds it into `signatureCount` (`EAS layers + storage deploys`). Caller-supplied mirrors
  add zero (the SDK stores nothing).
- 8eb5d81: Three review fixes: the declared `size` claim is now enforced on the FETCHED bytes even when it is `0` (the empty-file carve-out can't clamp the fetch cap, so a non-empty body whose hash matched inconsistent metadata previously verified `matches-author`; it is now the documented `mismatch`); `verifyAttestationUID`'s `maxBump` bound is the practical scan budget (`MAX_UID_BUMP_SCAN = 1024`, new export) rather than the uint32 wire range — the wire maximum meant 4.3 billion synchronous keccaks freezing the event loop; and the artifact parsers are strict at the promised boundary — `parseDataRef` shape-validates `uid` (bytes32), `resolvedBy` (address), and `chainId` (positive safe integer), and `parseWriteReceipt` rejects NaN/fractional `signatureCount` and non-bytes32 step uids as `MalformedArtifact` instead of branding corrupt IDs that fail later as misleading chain/ABI errors.
- c8b16f2: Four review fixes: the declared `size` claim no longer clamps the transport cap — an under-declared size (size 1, two-byte matching body) previously made every mirror abort and the read UNAVAILABLE (`AllMirrorsFailed`) instead of the documented `verification: 'mismatch'`; the claim is now a uniform post-fetch consistency check while the safety ceiling stays the caller/default cap. The folder-visibility TAG walk sweeps the FULL ancestor chain instead of short-circuiting at the first tagged node — "first tagged ⇒ all above tagged" doesn't survive TAG revocation, so a hole above a tagged descendant (revoked `/a` over tagged `/a/b`) was never repaired and the branch stayed invisible from the root listing (every read was already fetched; the sweep is free). `OnchainStoreIncomplete` now also wraps the MANAGER receipt leg (optional `managerTx` field) — a failed manager wait or missing contract address previously surfaced without the landed chunk state. And `readWeb3Bytes` re-checks the abort signal between `chunkAddress` and `getCode` (an abort during the pending address read no longer starts more RPC work).
- 98e1a87: `@efs/solidity`'s redirect follower now matches the ratified resolution spec (specs/09 / ADR-0067), keeping the two published SDKs identity-consistent: `EFSReader.followKind` follows ONLY `symlink` (2) — `sameAs`/`supersededBy` are non-followed terminals (canonicalization and version history are separate, deliberate operations; an exact DATA identity never silently advances) — and `resolveWithRedirects`' `maxHops == 0` default is the ratified `D_MAX = 16` (was 8), hard ceiling 32. `@efs/sdk`: the redirect-lifecycle receipt wait (`set`'s index leg, `remove`'s revoke sequencing) re-asserts the LIVE provider chain immediately before waiting, so a post-broadcast chain switch fails closed (`WrongChain`) instead of polling another chain — where a landed index could read as a false `IndexingIncomplete` or a landed revoke could abort before its required `indexRevocation` leg.
- 1856e91: The Solidity write path now enforces the reserved-key value contract, and URI redaction survives leading whitespace.

  `EFSLib` is a separate public write path from the TypeScript SDK, and it stored reserved property values verbatim — so `{key: "contentHash", value: "0xdeadbeef"}` produced a fully successful write whose file then failed every default TypeScript read with `malformed-claim`, mirror bytes intact. `writeFile`'s reserved-key loop, `setProperty` and `setPropertyAt` now all validate through one `_assertReservedValue`, reverting with `InvalidReservedValue`. `contentHash` and `size` are checked against their exact canonical forms; `contentType` gets a deliberately bounded structural check (shape, RFC 6838 restricted-name characters so media ranges are rejected, a 255-byte ceiling, and printable-ASCII-only parameters so CR/LF cannot reach a served header) rather than the full RFC 9110 grammar, because on-chain string parsing costs the caller gas on every write. Non-reserved keys stay unconstrained.

  Separately, `summarizeUri` now normalizes leading and trailing whitespace before deciding what to redact. Both its `data:` and userinfo tests are anchored, so a single leading space caused a `" data:…"` locator to print 200 characters of its inline payload, and a whitespace-prefixed credential URL to print its password. This matters on the read side in particular: `fetchVerified` can be called directly, and the chain is append-only, so legacy or foreign mirrors carry whatever they were minted with.

- 822e0cb: Two placement-gate completions: (1) `buildPlacementPinPlan` now stamps its plan as a hardlink placement (`hardlinkDataUID` + the schema/anchor stamps), so the exported builder+executor pair (`submitEdgePlan`/`submitLayeredTier1`) runs the full gate set — authorship, DATA schema, active-mirror readability, ANCHOR definition — at the layered boundary instead of bypassing everything `pins.place` checks; the edge submit context carries the indexer address for the mirror proof. (2) The concrete-anchor gate now binds the reused anchor to the REQUESTED slot: `buildFileWriteGraph` stamps the requested parent + canonical name, and the submitter verifies the reused ANCHOR's `refUID`, decoded name, and DATA bucket name exactly that slot — a valid ANCHOR from a different slot previously skipped the mint and silently overwrote a different path. The standalone placement plan carries no slot stamps (its anchor is caller-chosen by design).
- defb3c7: `buildMirrorPlan` now stamps its transport definition and anchor schema, so the layered boundary runs the transport-anchor gate on standalone MIRROR plans too. Previously `efs.mirrors.add({ transport })` (which takes the caller's UID verbatim) and the exported builder + `submitEdgePlan` pair sent an arbitrary or stale definition straight to MirrorResolver, paying for a reverted transaction instead of failing before broadcast.
- 79a102d: The standalone-namespace read methods (`graph.tags.active`/`list`, `graph.pins.active`,
  `props.list`, `mirrors.list`) now resolve the deployment from the LIVE provider chain, like
  `fs.*` reads. They previously used the construction-time `publicClient.chain.id`, so on a
  mutable EIP-1193 client that switched networks they could query old-chain contract addresses
  on the new chain (false misses / wrong-chain metadata). Each namespace gained an optional
  `liveDeployment` resolver used only by its reads; write methods keep the sync
  `getDeployment` (the submit context's chain guard fails a drifted write closed).
- 39e5683: Extend the wrong-chain write guard to the standalone write verbs. The previous fix
  covered `fs.write`/`fs.setOverview`, but `graph.tags.add`, `graph.pins.place`, `props.set`,
  `mirrors.add`, `redirects.set`, and `lists.create`/`add` share a separate edge submit
  context that did not assert the wallet was on the deployment chain — so a `ViemConfig`
  with a wallet bound/connected to a different chain than the public client could still send
  those EAS transactions to the deployment's addresses on the wrong chain. The shared edge
  submit context now runs the same fail-closed `WrongChain` assertion (before any tx) via a
  pre-flight thunk awaited in `submitEdgePlan`.
- 3942221: Five review fixes: completed on-chain storage now survives EVERY attestation-phase failure — a first-layer preflight abort/chain-guard failure (which escapes the submitter raw because nothing attested yet) is wrapped into a `WriteNotSentError` carrying `storage` when the deploys landed, instead of losing the reusable URI; the `/tags/system` lookup in `setOverview` and the `/transports/<scheme>` lookup in `mirrors.add` both route through the chain-guarded planning client (the last two raw-client planning reads); `OverviewOptions` now includes the fetch controls the overview read actually honors (`signal`, gateways, `fetchImpl`, host policy, `transports` — `maxBytes` stays excluded, the render ceiling is fixed); and a broadcast REDIRECT revoke whose receipt cannot be confirmed throws the new `RevokeUnconfirmed` carrying `revokeTx` (the revoke may still mine; a blind resend REVERTS as AlreadyRevoked once it does) — distinct from a confirmed revert (raw `ContractReverted`) and from `IndexingIncomplete`.
- a9ca3f2: Three review fixes completing the partial-state doctrine: attestation-phase failures on the default on-chain write now carry the COMPLETED storage — `WriteNotSentError`/`WriteRevertedError` gain an optional `storage` field (`web3Uri`/`chunkManager`/`chunkAddress`/`txHashes`, new `CompletedOnchainStorage` type) attached by the orchestrator once the deploys landed, so a rejected first EAS prompt or failed layer no longer invites a duplicate-storage retry (recovery passes `storage.web3Uri` as an explicit mirror); a mined layer whose EAS `Attested` logs can't be extracted (incomplete RPC logs, event drift) surfaces as `WriteRevertedError` with `mined: true` + the txHash + a do-not-resend cause instead of a bare throw that read as "unsent"; and `parseWriteReceipt` validates the known OPTIONAL typed fields when present (`data` via the shared DataRef shape rule, canonical `contentHash`, `status`/`gasless`/`reason` types) while still preserving genuinely unknown extension keys.
- 8ad5607: Three review fixes (one P1): a response with NO readable stream now FAILS the attempt instead of falling back to `arrayBuffer()` — the fallback buffered the entire attacker-sized body before any cap check ran (Content-Length is attacker-controlled and may be absent/understated), defeating the documented hard ceiling; every real fetch implementation streams, so bodyless responses are mock territory and failover proceeds. `timeoutMs` is bounded by the platform timer ceiling (`MAX_TIMEOUT_MS = 2_147_483_647`, new export) — larger values truncate to ~1 ms and aborted every attempt immediately. And CUSTOM abort reasons (`controller.abort('user cancelled')` — a string/object with no `name`) propagate verbatim: both the engine and the read path check `signal.throwIfAborted()` first instead of relying on an Error-shaped name.
- ad62a04: Three review fixes: (1) `efs.graph.tags.add` routes its `/tags/<name>` definition-resolution walk through the chain-guarded read client like every other planner, closing a provider-drift window that could feed a wrong-chain definition UID into the plan. (2) Artifact `ext` bags now survive the natural read-modify-write round-trip: `serializeDataRef`/`serializeWriteReceipt` re-emit a parsed `.ext` bag at the ENVELOPE (an explicit `ext` argument still wins), and `ext` is now formally reserved to the envelope — parsers reject a payload-level `ext` as `MalformedArtifact` instead of letting it masquerade as the caller's bag. (3) When an EFSIndexer `index`/`indexRevocation` tx broadcasts but its receipt confirmation fails, the new `IndexUnconfirmed` error preserves the in-flight tx hash, and the redirect verbs thread it onto `IndexingIncomplete.indexTx` — callers can reconcile the tx's fate/cost before the idempotent repair (a confirmed on-chain revert still propagates as `ContractReverted`).
- 5e6d64d: > **Redirect half superseded in the same release**: `followRedirectChain` and `RedirectHopLimit` were replaced wholesale by the ratified specs/09 engine (see the ratified-redirect-resolution change) — the at-cap-terminal semantics survive inside `walkSymlinks`. The read-only-namespace half below stands.

  Two fixes:

  - **A redirect chain whose length equals the hop cap is no longer rejected.** `followRedirectChain`
    threw `RedirectHopLimit` unconditionally after consuming `cap` followable hops, even when the
    destination of the last hop was a terminal (e.g. `followRedirects: 1` for `A → B` with no
    redirect from `B`). It now does a final terminal check after the last allowed hop: a chain that
    terminates exactly at the cap is valid; it only fails closed when a genuine further followable
    hop (or a cycle) exists past the cap.
  - **Read-only clients now type-expose the standalone read namespaces.** `EfsReadClient` omitted
    `graph`/`props`/`mirrors`/`redirects` entirely, even though the returned object includes them
    and their read verbs (`tags.active/list`, `pins.active`, `props.get/list`, `mirrors.list`,
    `redirects.get`) are lens-scoped and need no wallet. TypeScript callers on a read-only client
    can now reach those reads without an unsafe cast; the mutators (`add`/`set`/`place`/`remove`)
    remain gated to the write-capable `EfsClient`. (New `TagsReadNs`/`PinsReadNs`/`EfsGraphReadNs`/
    `PropsReadNs`/`MirrorsReadNs`/`RedirectsReadNs` types, derived from the full namespaces.)

- cd2d013: `Tier1Submitter.submit` now refuses a context whose `roles` overrides diverge from the signing account, and derives the receipt's roles instead of taking them from the caller. Tier-1 is self-submitted by definition — one wallet signs, pays and broadcasts — so honoring an override stamped a false `author`/`signer`/`payer` onto a CONFIRMED receipt, the durable artifact third parties trust; a `submitter` override was even worse, recording that a relay stood in for the author when none existed. `submitter` is now absent on Tier-1 receipts. Rejected rather than silently dropped: a caller who set the override holds a wrong model of what this path does. Genuine payer/submitter divergence belongs to the deferred AA/relay submitters (mechanism `gateway`/`erc4337`), which are unaffected.
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

- 4f61b2b: The mirror transport-anchor check now runs before the orchestrated write's PAID storage deploys, not just at the submission boundary. `fs.write`'s auto-store path resolved the transport, deployed the SSTORE2 chunk + manager, and only later hit the boundary gate — so a well-shaped but invalid `opts.transportDefinition` (or a stale deployment-map UID) left the caller paying for orphaned storage on a write that could never complete. Both paths now share one implementation (`assertTransportAnchors`): ANCHOR schema plus `/transports/` ancestry within the contract's depth bound.
- 8478ff6: `FetchOptions.transports` now honors its documented "Restrict/**prioritize**" contract: the caller's ordered preference reorders the candidate mirrors instead of only filtering them. The fetch engine takes the first mirror that yields bytes, so `transports: ['https', 'ipfs']` previously had no effect on selection at all when the on-chain mirror list happened to list IPFS first. Ordering is stable within a scheme, so the on-chain priority still breaks ties between same-scheme mirrors, and duplicate entries take their first-mentioned rank.
- f19c0b4: Partial-write honesty fixes in the layered submitter: (1) a layer that MINES successfully but whose `Attested` logs cannot be extracted now throws the new `WriteUidsUnknownError` (layer, mintedRefs, landed, txHash, and the same `storage` attachment seam) instead of `WriteRevertedError{mined:true}` — that class's contract says the refs did NOT mint, while in this state every ref exists on-chain, so recovery code branching on the top-level fields could resend and duplicate the whole layer. (2) `WriteNotSentError`'s message and docs no longer bless a whole-write retry unconditionally: `fs.write` does not resume, so the message now scopes the no-in-flight-tx claim to the unsent layer and, when earlier layers landed (or storage completed), directs recovery through `landed`/`storage` instead of a retry that would re-mint attestations, re-pay deploys, or revert on permanent duplicate anchors.
- 9e0bc52: Two write/read correctness fixes:

  - **(P1) `efs.fs.list('/dir')` no longer throws on a real chain.** `getDirectoryPageByAddressList`
    declares TWO top-level ABI outputs (`items`, `nextCursor`), so viem decodes its return as a
    positional tuple, not an object — the unfiltered directory path read `.items` off the tuple
    (`undefined`) and threw before returning any entries. Now destructured positionally. (The
    filtered/by-schema siblings wrap their values in one `DirectoryPage` struct and were unaffected.)
    The unit-test mocks were returning an object, masking this; they now return the tuple shape real
    viem produces.

  - **(P2) `fs.write`/`fs.setOverview` fail closed on a wallet/public-client chain mismatch.** The EFS
    deployment (addresses + schema UIDs) is resolved from the public client's chain, but writes run on
    the wallet's chain. A `ViemConfig` with a wallet bound/connected to a different chain than the
    public client would send the EAS/storage txs to the wrong chain's contracts (and await receipts on
    the public chain). The SDK now asserts the wallet chain equals the deployment chain before any tx,
    throwing a typed `WrongChain` error (added to the public `EfsErrorCode` union).

- 0c07264: `contentType` validation moved onto the shared plan builder and gained a size ceiling.

  The earlier fix validated only `fs.write`'s `opts.contentType`, but `efs.props.set(dataUID, 'contentType', …)` writes the same authoritative binding through a different door and stayed unchecked — a caller could replace a file's `contentType` with `'not-a-media-type'`, after which readers expose the malformed value and `fs.overview()` misclassifies textual content as binary. `assertContentType` now lives beside `buildPropertyPlan` and runs inside it whenever the canonical key is `contentType`, so `props.set` and direct callers of the exported builder are both covered. Other property keys are unaffected — this is a reserved-key rule, not a value policy for every property.

  A `MAX_CONTENT_TYPE_BYTES` ceiling (255 bytes) also now applies. A syntactically valid but enormous media type is ABI-encoded into the `EFSBytesStore` creation transaction, and on the default no-mirror path the SSTORE2 content chunk is deployed FIRST — so an initcode-breaking value left the caller with storage they had already paid for and a write that could not complete. RFC 6838 caps type and subtype names at 127 characters each, so 255 admits any registered `type/subtype` with room for parameters.

- 43e9ed5: `opts.contentType` is now validated as an IANA media type before anything irreversible happens. specs/future-proofing.md §8 makes the attested `contentType` authoritative — readers never fall back to the transport header or the file extension — and requires validation on write, but a malformed value like `'not-a-media-type'` rode unchecked into the paid `EFSBytesStore` deploy (an ERC-5219 store that then reports nonsense to every gateway) and into the authoritative `contentType` PROPERTY, where it made `fs.overview()` classify plainly textual content as binary. The check runs at the top of `resolveMirrors`, before the deploys, for the same reason the transport-anchor gate does: past that line the gas is spent and a late throw strands orphaned storage. `type/subtype` with optional parameters (`; charset=utf-8`) is accepted; omitting `contentType` still leaves the file undeclared.
- 5d44417: Three independent hardening fixes:

  - **`fetchVerified` validates `maxBytes`.** The mirror engine is public surface, so a direct
    caller could pass `NaN`/`Infinity` (the cap checks are `>` comparisons — `NaN` never rejects
    an oversized payload, `Infinity` disables the 50 MB ceiling). It now rejects a
    non-finite/non-positive cap up front, matching the `fetchRef` wrapper.
  - **A throwing progress hook can no longer corrupt a write.** `submitLayeredTier1` wraps the
    per-layer `onLayer`/`onProgress` callback: an exception from best-effort reporting code, after
    an early layer mined, is swallowed instead of propagating and aborting the remaining
    irreversible dependent layers (which would manufacture a partial write with no structured
    error). Cancellation remains via the explicit `AbortSignal`.
  - **Standalone-namespace reads guard the resolve-then-read TOCTOU.** `graph.tags.active/list`,
    `graph.pins.active`, `props.list`, and `mirrors.list` resolved `liveDeployment()` then read
    via an unguarded client; a provider that switched chains in between used the resolved chain's
    addresses on the new chain. They now route reads through a `chainGuardedPublicClient` pinned
    to the resolved deployment chain (fail closed with `WrongChain`), matching `readContext`.

- 09aba23: Two read/construction hardening fixes:

  - **Validate `maxBytes` before it becomes the fetch cap.** `fs.read`/`readText`/`readBytes`
    forwarded a caller `maxBytes` straight to the engine, whose cap checks are all `>`
    comparisons. A non-finite cap slipped the safety ceiling: `NaN` never trips a `>` (an
    over-cap body reads as in-bounds) and `Infinity` disabled the 50 MB default outright,
    letting an untrusted mirror buffer unbounded. A non-finite or non-positive `maxBytes` now
    fails closed with `InvalidArgument` before any read.
  - **Reject a chainless `ViemConfig` public client at construction.** A viem client built
    from a bare transport (no bound `chain`) can answer `getChainId()` but exposes no
    synchronous construction chain. The write/raw/eas paths resolve the deployment sync from
    `publicClient.chain.id` and validate it against the live chain (the deliberate "writes
    validate, reads re-resolve" split), so a chainless client had no stable anchor — reads
    worked while writes/`efs.eas.*`/`efs.raw.*` threw a confusing `DeploymentNotFound` on
    first use. `createEfsClient` now fails fast with an actionable `InvalidArgument` telling
    the caller to bind a chain (or use the `{ provider, chain }` form).

- 70f6a64: Two follow-up fixes to the previous round's hardening.

  CID varints are now decoded without 32-bit bitwise arithmetic. JavaScript's `<<` and `|=` coerce to int32, so a five-byte varint silently lost its high bits: `81 80 80 80 10` encodes 4294967297 but read back as version 1, and the new minimality guard could not see it — a base16 URI carrying that sequence passed the whole write preflight even though CID parsers and gateways reject the unsupported version. The accumulator now multiplies instead of shifting, and any field exceeding uint32 is refused.

  The Overview system TAG definition is now pinned to the deployment's canonical `/tags/system` anchor rather than merely checked for being _some_ ANCHOR. A direct caller supplying any other real tag definition — `/tags/nsfw`, say — would mine the TAG under the wrong definition, and because directory reads resolve the `system` exclusion to the canonical `/tags/system` UID, the README would remain visible in safety-filtered listings: the Overview contract quietly unfulfilled rather than loudly broken. The boundary now resolves `/tags/system` through the indexer and requires a match, failing closed when it cannot. `SYSTEM_TAG_PATH` moved to `types.ts` so the submit boundary can reference it without an import cycle; `writes/overview.ts` re-exports it, so the public name is unchanged.

- 17b395b: Fix a write-path correctness bug: a freshly written file did not appear in the
  author's own lens directory listing, because the ancestor-walk **folder-visibility
  TAGs** (overview.md "Upload flow" step 7; ADR-0038, ADR-0041) were never emitted.

  A folder only shows in an attester's lens listing when that attester has an active
  `TAG(definition = DATA_SCHEMA_UID, refUID = folderAnchor, weight = 1)` under it. The
  write path now emits one such TAG for every generic ancestor folder from the file's
  immediate parent up to **root exclusive** that the uploader hasn't already tagged:

  - **Newly-created** folders (the `createParents` / `mkdir -p` chain) always get a
    TAG (brand-new folders).
  - **Existing** ancestors are walked **bottom-up** via
    `EdgeResolver.getActiveTagWeight`, short-circuiting at the first already-tagged
    ancestor (steady-state zero cost). Existence checks are fanned with `Promise.all`.

  The TAGs are threaded into the write DAG in a layer **after** every folder ANCHOR and
  PIN, so a `createParents`-minted folder exists on-chain before its TAG references it
  (via the existing symbolic-ref + per-layer submit mechanism). Root is never tagged
  and the file's own leaf anchor carries no TAG. Hardlink placements into a new subtree
  also tag their ancestor folders.

- 3a4734e: Four review fixes: `web3://` mirror reads now honor cancellation and the per-attempt timeout — `Web3Reader`/`readWeb3Bytes` accept an `AbortSignal` (checked per chunk RPC) and the fetch engine arms the same controller+timer envelope as HTTP attempts, so a stalled RPC or hostile manager's chunk walk can't block failover; `readWeb3Bytes` validates `maxBytes` at its public entry (RangeError, consistent with the other exported transport helpers — its positional `maxBytes` param became an options object, with a pre-1.0 numeric shim); `parseWriteReceipt` validates ALL required receipt fields before branding (`mechanism`, `roles` with address-shaped author/signer/payer + optional submitter) so corrupted recovery artifacts die at the `MalformedArtifact` boundary; and a storage-deploy receipt wait that fails after broadcast now throws the new `OnchainDeployUnconfirmed` (code `PartialBatchFailure`) carrying the in-flight `txHash` — the outcome is unknown, the deploy may still mine, and a blind `fs.write` retry would pay for a duplicate deploy (previously a bare classified RPC error with no hash; a post-broadcast chain drift now also rides in this shape as `cause` instead of a hash-less `WrongChain`).
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

- b48366a: Mirror preflight now parses `web3://` locators with the strict `parseWeb3Uri` validator. `resolveTransport`'s web3 branch deliberately defers address parsing to the chain reader, so the previous structural check accepted `web3://0x1234` — a file could confirm with that as its only retrieval method and then fail every read. Read behavior is unchanged (reads still tolerate what the router tolerates); this is a write-side preflight only.
- 87e4ca8: Two fixes:

  - **A mid-write abort preserves partial-write context.** `submitLayeredTier1`'s per-layer
    cancellation check ran before the layer's refs were available and let a raw `AbortError`
    escape — so cancelling between wallet confirmations after an earlier layer mined dropped the
    `landed` UID map. The check now runs after the refs are built and, once a prior layer has
    landed, folds the abort into `WriteNotSentError` (`PartialBatchFailure`, the `AbortError` as
    `cause`) for recovery; an abort before the first layer (nothing landed) still escapes raw.
  - **`detectAccount`'s cache is scoped per connector.** The profile cache was process-global,
    keyed only by `address@chain`, but `getCapabilities` (→ `gasless`/batch) is
    connector-dependent. Profiling an account through a wallet without EIP-5792 and then through
    a different connector that supports it reused the stale profile. The cache is now scoped by
    the connector (the wallet client object), so a different connector never reuses another's
    capability profile (`efs.account.capabilities()` passes the wallet as the scope).

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

- bfbdcb5: The viem-form write-capable overload of `createEfsV1Client` now requires an account-BOUND wallet client (`walletClient.account: Account`). An unbound wallet (`createWalletClient({ chain, transport })`) cannot sign — every write verb it advertised threw `WalletRequired` at runtime — so it now falls through to the read-only overload and gets `EfsReadClient`. A wallet whose account is statically `Account | undefined` also types as read-only: narrow the wallet (or rebuild it with the account bound) to get the write surface. Runtime behavior is unchanged.
- 6971aca: fix(writes): resolve transport per mirror; fail closed on unimplemented `resume`

  - **Per-mirror transport** — `fs.write` now resolves a `/transports/<scheme>` anchor for
    EACH mirror URI rather than deriving one from the first. A mixed-scheme durability set
    (e.g. `['ipfs://…', 'ar://…']`) previously published every later URI under the first
    URI's transport anchor, writing permanently-wrong transport metadata. The write-graph
    builder's `mirrors` input now carries `{ uri, transportDefinition }` per entry (the
    Solidity `Mirror` struct already modeled this). An explicit `opts.transportDefinition`
    still applies to all entries.
  - **`resume` fails closed** — `fs.write` now throws `NotImplemented` when `opts.resume` is
    supplied. Resume was accepted but ignored: it re-submitted a fresh plan with an empty UID
    map, re-sending already-landed layers and double-minting DATA/MIRROR/PROPERTY/ANCHOR
    records on a partial-write retry. It will be re-enabled once it seeds/skips from the
    receipt's landed UIDs.

- 055937c: Close the last two cross-chain gaps for mutable EIP-1193 clients:

  - **Writes now guard the public client too, not just the wallet.** `fs.write`,
    `fs.setOverview`, and the standalone edge writes use the public client for parent/transport
    reads and `waitForTransactionReceipt`. If a `ViemConfig` public client drifted to another
    chain while the wallet stayed on the deployment chain, the write could send on the
    deployment chain yet read/wait on the wrong one. The write preflight now asserts BOTH the
    wallet and the public client are on the deployment chain (skipped only when there's no
    bound account, where the write fails closed with `WalletRequired` anyway).
  - **`efs.eas.getAttestation` and `efs.decode(uid)` guard a drifted public chain.** They read
    at the construction-chain EAS address; the public client handed to `makeEasVerbs` now
    validates the live chain matches the deployment, failing closed with `WrongChain` on drift
    rather than returning a false absence or wrong attestation from the old address.

- 31a05a4: The wrong-chain write guard now queries the wallet's LIVE chain (`getChainId()`) instead
  of trusting the bound `wallet.chain`. A bound `chain` is fixed at client construction and
  is not updated when an injected wallet switches networks, so a stale-but-matching bound id
  could pass the preflight while the provider submits the write on its _current_ network —
  to deployment addresses resolved for a different chain. The guard now always asks the
  provider's current chain before any write/revoke, closing that gap.
