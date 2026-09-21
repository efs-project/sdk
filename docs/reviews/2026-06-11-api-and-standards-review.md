# API & standards review — 2026-06-11

> A 6-dimension expert multi-agent review (TS namespace/API, pass-2 seam reconciliation, Solidity SDK + standards applicability, type design, standards cross-check, holistic coherence). 50 raw findings → 40 survived **adversarial verification** (each finding re-checked by a skeptic told to reject overstated "breaking" claims). This is the actionable record. Priorities: **before-freeze** (lock the public surface before first publish) · **before-launch** (additive, safe after freeze) · **later** (deferred namespaces).

## Bottom line

- **Is the TS SDK solid?** Yes, structurally — the boundary (EIP-1193 + viem-inside), write-gating, branded refs, named option types, and error tree all held up. The verification pass **deflated most "critical/breaking" alarms**: nearly everything flagged as breaking-if-deferred turned out to be *additive* under the repo's named-exported-types policy (ADR-0008). The real debt is narrower: a handful of genuine surface locks (multi-chain identity, partial-write state, verification plumbing, USD-range) and a **large amount of planning-doc drift** (the shipped code is usually right; `sdk-architecture.md` is stale).
- **Do the standards findings apply to the on-chain SDK?** Yes, and correctly — but mostly as **documentation + invariants**, not signature changes, because `@efs/solidity` is a compile-in `internal` library (no selectors/ABI), so almost nothing about it is "breaking" and the heavy on-chain concerns (gas-cap chunking, SSTORE2, path hashing) belong to the **immutable protocol contracts**, not this lib. The one real lib-scope question is whether `pinFile`/`mkdir` expose EAS-native lifecycle fields — and even that is an additive overload, not a freeze gate.
- **Most important correction to our own prior recommendation:** see §F — reserving an `EfsIndexProvider` config seam would **re-introduce the bundled-indexer framing James explicitly stripped**. We should *not* add it. The real multi-chain seam is `DataRef.chainId`, not a provider map.

## A. Before-freeze — TS surface locks (DO NOW; cheap, confirmed)

| # | Change | Why | File |
|---|---|---|---|
| A1 | **`DataRef` gains `readonly chainId: number`**; propagate to `ReadResult.data`, `FileStat.data`, `WriteReceipt.data`. Fill from `chainIdOf(publicClient)`. | Confirmed multi-chain identity gap — a ref without its chain can't be resolved cross-chain. The genuine seam (not a provider map). | types.ts, index.ts |
| A2 | **`fetch` can verify**: fold the resolving attester into the ref `read` returns / `fetch` consumes (e.g. `DataRef` carries `resolvedBy`, or `read` yields `{uid, resolvedBy}`). | `fetch(DataRef)` currently drops the attester that contentHash verification needs — the verified two-step flow is broken open. | types.ts, index.ts |
| A3 | **Partial-write state**: add `export type CallStatus = 'pending'|'confirmed'|'offchain-failed'|'reverted'|'partial'`; add `status?: CallStatus` on `WriteReceipt`/`BatchReceipt`; restore `BatchReceipt.partialFailure?` + `txHashes`. Keep `done`/`ok` as the binary view. | EIP-5792 status `600` (half-written file) is unrepresentable today → an abandoned sequential run returns a success-shaped receipt. Real footgun. | types.ts |
| A4 | **`WriteEstimate.estimatedUSD: number` → `usd?: { min; max; priceSource?; asOf? }`** (or omit until pricing lands). | Bare scalar violates the range-USD doctrine we just documented in future-proofing.md §5. Our own rule. | types.ts |
| A5 | **Branded `ContentHash = string & { __brand: 'ContentHash' }`** in content/hash.ts; `hashContent` returns it (trusted constructor); apply to `WriteReceipt.contentHash`. Add `asContentHash(s): ContentHash \| undefined` coercer for deserialized receipts. Do **not** brand `verifyContent`'s `claimedHash` param. | `contentHash` is an untyped string on the receipt; the hash is load-bearing. | content/hash.ts, types.ts |
| A6 | **`OperationResult`**: `error?: Error` → `error?: EfsError`; add `kind` (op-type union `'write'\|'pin'\|'tag'\|'property'\|'list'\|'mirror'\|'sort'`) and `txHash?: Hex`. Runtime: classify per-op failures into `EfsError` when batch lands. | A bare `Error` doesn't carry `.code` type-safely; partial-failure UIs need which op kind failed and its tx. | types.ts |
| A7 | **`stat()` returns non-nullable discriminated `FileStat`**: `{ exists: false } \| { exists: true; data; resolvedBy; ... }`. Drop `\| null`. | Absence is modeled two ways (`ReadResult\|null` vs `FileStat.exists`); pick one. Matches design + Solidity `(bool exists, …)`. | types.ts, index.ts |
| A8 | **`TransportName` open union** for `FetchOptions.transports`: `'web3'\|'arweave'\|'ipfs'\|'magnet'\|'https'\|(string & Record<never,never>)`, ideally derived from the planned `TRANSPORT` constant (ADR-0011). | The one mirror/SSRF-adjacent piece that is genuinely breaking-later; cheap now. | types.ts |
| A9 | **`VerificationStatus`** splits tampering from authoring-bug: add `'malformed-claim'`; return it from hash.ts where the claimed hash fails the 64-hex regex (vs `'mismatch'` = real content/hash divergence). | Security-meaningful distinction (tamper vs attester typo). | content/hash.ts |
| A10 | **`WriteMechanism` literal `'multiAttest-sequential'` → `'sequential'`** (matches `opts.via` + 3 design sites). | Code/design divergence; cheap rename pre-publish. | types.ts |
| A11 | **Define `DirEntry`** (`name` + `anchorUID`/`dataUID` + `kind`) and make `fs.list` element `DirEntry`, not `DataRef`. | `list` returns raw refs; design specifies dir entries. Surface lock. | types.ts, index.ts |
| A12 | **Reserve `opts?: PreviewOptions`** on `fs.preview` (near-empty exported type) so the simulation seam can land additively. Drop `PathRef` from public exports (unconsumed dead surface) — or wire it where dynamic refs are returned. | Cheap seam reservation; remove dead exported surface. | types.ts, index.ts |

## B. Before-freeze — Solidity (`@efs/solidity`)

| # | Change | Note |
|---|---|---|
| B1 | **Fix event drift**: `EfsFilePinned` → `EFSFilePinned`; restore `string indexed path` (scaffold regressed the design's hash-filterable indexed path, `sdk-architecture.md:1031`). | Real drift against a decided shape. |
| B2 | **EAS-native lifecycle**: add a `pinFile(path, dataUID, PinOpts)` **overload** (`expirationTime`/`revocable`/`refUID`) — *not* a mutation of the existing signature. Deferring is **not** a semver-major (compile-in `internal` lib), but settle the seam pre-freeze for coherence. | Append-fields-to-struct still re-encodes calldata, so add as overload, not by editing in place. |
| B3 | **Parity stubs**: extend `EFSWriter` + lock the full parity signature set as `revert NotImplemented` stubs before publishing; add the missing `_efsMkdir` wrapper (decide if it emits an event — design has none yet). | Lock the surface; don't ship a partial wrapper set. |
| B4 | **NatSpec invariants** (additive): `read()`/`readAs()` return the *active* pin per lens (revocation/expiry resolved on-chain); the lib **must not hash paths** (path encoding is a protocol-contracts concern, settle there before freeze). | Drop the proposed `PinView`/`PinOpts` *structs* for reads — doc note only. |

## C. Doc reconciliation — code is right, `planning/Designs/sdk-architecture.md` drifted

These are **doc edits**, not code changes (verification confirmed the shipped code is correct):

- **C1 — namespace casing**: lowercase `efs.eas` everywhere in the design doc (lines 70, 129, 170, 336, 631–646, 827, 845…). Code matches ADR-0008.
- **C2 — schema vocabulary**: add `SCHEMAS.REDIRECT`; move `SORT_INFO` out of the frozen-9 enumeration (it's a separate not-yet-frozen sort schema per the doc's own freeze flag at :522). Fix the stale `deployments.ts:25` pointer ("contracts ADR-0048").
- **C3 — `WriteMechanism` `'sequential'`** in the 3 design sites (pairs with A10).
- **C4 — lens singular/plural**: reconcile `types.ts` `lens` vs design `lenses` (:261). A single `Lens` already encodes the ordered first-wins stack, so align the *doc* to `lens` (don't rename code to `lenses`).
- **C5 — `OperationResult`/`WriteReceipt`/`WriteEstimate` field names** in the design (`mechanism`, `txHashes`/`transactions`) to match A3/A6 and the code.

## D. Standards-doc additions (standards.md / future-proofing.md)

- **D1 — EAS EIP-712 domain**: at runtime obtain the domain via the deployed verifier's `getDomainSeparator()` (binds name+version+chainId+verifyingContract); record observed `name "EAS"`, `version "1.4.0"` (eas-contracts master) only as a sanity check — they vary by deployment. Do **not** assert EIP-5267 `eip712Domain()` support (absent in master).
- **D2 — ERC-2098** is **TS-verification-scoped only** (half-sentence clarification on standards.md:39 / future-proofing.md §9).
- **D3 — SSTORE2 / EIP-7825 gas boundary**: add a write-side note to the On-chain SDK section (chunking under ~16.7M gas is a protocol-contracts invariant; the lib inherits it).
- **D4 — payable resolvers / EAS `value`**: one-line note on the Solidity write surface (forward resolver value; already handled in `buildMultiAttest`).

## E. Before-launch (additive, safe after freeze — do when the relevant pass lands)

- `OperationResult.kind`/`txHash` full wiring; `WriteReceipt`/`BatchReceipt` `attester?: Address` (observability).
- `ReadResult`/`FileStat` provenance/freshness triple (defer to graph/mirrors pass; provably additive).
- `connect()` late-bind seam (MetaMask M15 flow) — **needs an ADR** (see §G).
- `FileStat` `mirrors?`/`attester?`/`time?`; `VerificationStatus` size-exceeded arm.
- Mirror/SSRF `FetchOptions` knobs beyond `transports`.

## F. Explicitly NOT doing (verification rejected or strongly cautioned)

- **❌ `index?: EfsIndexProvider` config seam / `EasGraphQLProvider` default** — re-imports the **bundled-indexer framing James explicitly stripped** (sdk-architecture.md revision log 2026-06-10; Q3 resolution 2026-05-28). Reverse-lookups stay caller-supplied. *(This reverses a recommendation we gave earlier — flag to James.)*
- **❌ Per-chain provider map preemptively** — the cross-chain retrofit is additive, not breaking. `DataRef.chainId` (A1) is the real seam.
- **❌ `defaultLenses?: readonly (Lens\|Address)[]`** — `defaultLens: Lens` already encodes the ordered stack via `lens([...])`; the plural form re-adds the address-vs-Lens ambiguity `resolveLens` exists to remove.
- **❌ NotImplemented shims for `raw` contract handles / `eas` attest verbs** — advertises absent capability for zero semver benefit (additions are non-breaking).
- **❌ `sort?`/`schema?` on `ListOptions` standalone** — fold into the dedicated lists/sorts namespace pass where the cursor-encoding decision is actually made.

## G. Open questions for James

1. **Lens-state model** (Q4, real fork): commit to the design's mutable `efs.lenses.set/add/remove/active()` stack, **or** the simpler immutable `defaultLens?` config? Both are non-breaking to extend, but the *exported `defaultLens` field* is the lock-in. **Rec:** keep `defaultLens?: Lens` as the documented model now (simpler, sufficient); reserve `active()` as a shim; revisit mutation when identity work lands.
2. **`connect()` late-bind**: the vault design's MetaMask flow needs a post-construction `connect(account)` path that ADR-0008 doesn't define. **Rec:** write a short follow-up ADR defining `connect()` rather than forcing account-at-construction.
3. **`pinFile` lifecycle overload** (B2): expose `expirationTime`/`revocable`/`refUID` now via overload, or defer? **Rec:** add the overload pre-freeze for coherence (it's cheap and signals intent), bodies still revert.
