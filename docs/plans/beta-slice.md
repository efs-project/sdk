# Beta-slice implementation plan

> **What this is:** the plan for the first functional slice of `@efs/sdk` — enough to read and write real EFS files, with the public API *shapes* frozen correctly before publish. Grounded in the schema-freeze-branch contracts, the 2026-06-10 holistic review, and an adversarial review of this plan. Status: **draft for James's review** before implementation.

## Goal

A dev installs `@efs/sdk`, points it at a chain, **writes a file** (resumable, content-dedup-safe) and **reads it back** (bytes, content-verified, with attribution). TypeScript only; `@efs/solidity` implementation follows later.

## Grounding facts (verified against `.wt-schema-freeze`, 2026-06-10)

- **9 frozen schemas** (`deploy/lib/schemas.ts:36-66`): ANCHOR `string name, bytes32 schemaUID`; PROPERTY `string value` (revocable, ADR-0052); **DATA `""` (empty)**; PIN `bytes32 definition`; TAG `bytes32 definition, int256 weight`; MIRROR `bytes32 transportDefinition, string uri`; LIST/LIST_ENTRY/REDIRECT.
- **A file's `contentHash`, `size`, `contentType` are reserved-key PROPERTYs bound to the DATA UID** — each a 3-attestation bundle (key-anchor→DATA, PROPERTY(`string value`), binding PIN), **lens-scoped per attester**. The hash value is a **self-describing multibase-multihash / CID string** (no on-chain algorithm marker); the encoding spec is **unwritten upstream** → the SDK must own it.
- **No chain is deployed yet** except the contracts repo's local **chain 31337** (Sepolia fork). Real Sepolia is `0x…TBD` pending James's freeze sign-off; schema UIDs are on-chain getters; addresses are post-deploy (CREATE3 planned, not realized).

## API surface — namespaced, per the architecture doc (NOT flat)

**Correction from review:** an earlier draft of this plan froze flat free functions (`pinFile`, `read`). The authority — `planning/Designs/sdk-architecture.md` (Q2 resolved: resource-namespaced, eight-verb vocabulary, à la Stripe/Prisma) — specifies a **namespaced client**. We follow the doc; the scaffold's flat `index.ts` is realigned as part of this slice. (See Decision F.)

```ts
const efs = createEfsClient({ publicClient, walletClient?, deployments? })
// Exact verb names + the eight-verb vocabulary are owned by sdk-architecture.md;
// the beta implements the efs.fs slice + the efs.lenses / efs.EAS / efs.raw seams.

// efs.fs — files
efs.fs.write(path, bytes, opts?): Promise<WriteReceipt>
efs.fs.read(path, opts?): Promise<ReadResult | null>   // resolves a ref + attribution
efs.fs.fetch(ref, opts?): Promise<EfsFile>             // ref → bytes (+ verification)
efs.fs.stat(path, opts?): Promise<Stat | null>
efs.fs.list(path, opts?): AsyncIterable<DataRef>       // hides cursor/0-restart/20-lens footguns (DX-9)
efs.fs.preview(path, bytes): Promise<WriteEstimate>    // cost/tx/sig preflight (UX-1/UX-13)

// efs.lenses — resolution (trivial v1: addr→[addr], identity()=ENS→[addr]; ADR-0039 seam)
// efs.EAS    — vendored viem-native EAS access (ADR-0002)
// efs.raw    — typed escape hatch to the contracts
```

### Frozen value shapes (align to the architecture doc's richer types)

```ts
type WriteReceipt = {
  contentHash: string                 // multihash/CID string (SDK-owned encoding, Decision A)
  data?: DataRef
  steps: Array<{ id: string; uid?: AttestationUID; done: boolean }>  // path-qualified, idempotent (see Resume)
  signatureCount: number
  mechanism: 'multiAttest-sequential' | 'eip5792' | 'erc4337'
}
type ReadResult = { data: DataRef; resolvedBy: Address }            // which lens/attester won (UX-4)
type EfsFile = {
  bytes: Uint8Array
  contentType?: string
  // TRUST-RELATIVE, not absolute integrity (see Verification semantics):
  verification: 'matches-author' | 'no-claim' | 'mismatch'
  hashAuthor?: Address                 // whose contentHash PROPERTY we checked against
}
type WriteEstimate = {
  attestations: number; transactions: number; signatureCount: number
  chunkDeploys: number                 // large files store bytes via SSTORE2 chunks
  gas: bigint; estimatedUSD?: number; warnings: string[]
}
// Branded UID kinds — wrong-UID-kind is the dominant integration bug (DX-13)
type DataUID = `0x${string}` & { readonly __kind: 'DataUID' }
type DataRef = { readonly __brand: 'DataRef'; readonly uid: DataUID }
type PathRef = { readonly __brand: 'PathRef'; readonly path: string }
```

### Seams to declare now (throw `NotImplemented` in v1, but don't foreclose)

Large-file **SSTORE2 multi-chunk** read/write + a **streaming/partial-read** path; **update-with-`previousVersion`** (version DAG) and **unpin/delete**; **batch-many-files**. The architecture doc carries these; freezing `fetch`/`write` without their seams would force a breaking change later.

## Verification semantics (the honest model — review BLOCKER #2)

`contentHash` is a **lens-scoped PROPERTY** — anyone can attest their own onto a popular DATA. So verification is **trust-relative, not absolute integrity**: the authoritative `contentHash` is the one attested by **the same attester whose lens won placement** (`ReadResult.resolvedBy`). `efs.fs.fetch` checks bytes against *that* author's claim and reports `matches-author` / `no-claim` / `mismatch` (plus `hashAuthor`). The SDK must never imply a bare `'verified'` that an attacker's lens could satisfy.

## Resume / dedup (review BLOCKER-adjacent #6)

On-chain `dataByContentKey` dedups DATA (same content → same DATA UID), so a retry resumes the DATA mint. But **placement is per-path** and MIRROR/PROPERTY attestations are **not** content-deduped. So the receipt's `steps[]` are **idempotent per step-id, path-qualified** — resume skips only mined steps, always mints a fresh placement PIN for the path, and records each MIRROR/PROPERTY UID *before* the crash window so a layer-1 retry can't double-mint.

## Click count — honest (review SHOULD-FIX #4)

The DAG is `DATA → key-anchor → binding-PIN` = **3 layers per property** (the key-anchor references DATA's mined UID, so it can't be layer-0). A bare file (no properties) is 2 layers. Recording contentType+contentHash+size keeps depth at 3 (the three bundles parallelize within their layers) but it is **~3 clicks, not 2**. State the count as a function of property count; stop implying 2 is typical.

## Build order (Sepolia-independent first)

1. **`chain/` deployments registry** — `DeploymentsMap` shape (addresses + 9 schema UIDs per chainId) + a **construct-time schema-UID mismatch check**. Seed chain 31337 (Decision C). Sepolia pending.
2. **`eas/`** — vendored EAS ABIs; `encodeSchemaData`, `attest`/`multiAttest`, UID derivation/verification.
3. **`content/`** — the SDK-owned multihash/CID content-hash encode + verify (Decision A).
4. **`schema/`** — the 9 schema encoders; the contentHash/size/contentType reserved-key PROPERTY bundles.
5. **`write/` — `efs.fs.write`** — DAG, one `multiAttest` per layer, thread mined UIDs, dedup, `onProgress`, `resume`, `WriteReceipt`.
6. **`read/` — `efs.fs.read`/`fetch`/`list`** — lens-resolved active DATA → ref + `resolvedBy`; transport-priority mirror resolution + `message/external-body` + trust-relative verification; the iterator.
7. **`lenses/`** — trivial resolver + ENS `identity()`; ADR-0039 hierarchy seam.
8. **`errors/`** — typed `EfsError` tree + the **null-vs-throw convention** (read miss → `null`; misuse → throw). Write the error-model ADR alongside.
9. **`preview` + branded types + chain-mismatch detection** woven through.

## Test / validation strategy

- **Unit** — encoding, hashing, DAG layering, lens resolution, UID derivation. No chain.
- **Integration against chain 31337 NOW** — boot the contracts repo's local fork via anvil/prool, point the SDK at the 31337 deployments, run real read/write **before** the Sepolia sign-off (Decision C).
- **`examples/ts-quickstart`** as the acceptance test — "write a file, read it back, verify bytes."
- **Sepolia fork** once live (ADR-0005).

## Out of scope for the beta

Reverse-lookup/discovery (`NotImplemented`), account-groups, the gateway, the `@efs/solidity` implementation (signatures only), subgraph helpers, large-file streaming (seam only).

## Decisions to surface to James (important / controversial)

- **F. Namespaced vs flat API — realign to the architecture doc (rec).** The validated design is namespaced (`efs.fs.write`); the scaffold drifted to flat (`pinFile`) — an unforced error on my part. **Rec:** realign to namespaced (the doc wins). *Going flat instead would be a conscious override of the validated, expert-reviewed Q2 decision — flag if you want that.* This is the one to settle first; it reshapes the scaffold's `index.ts`.
- **A. The SDK defines the content-hash encoding convention.** Upstream left multihash/CID encoding + vectors unwritten, so whatever the SDK emits becomes de-facto standard. **Rec:** multibase-multihash, keccak256 default (per ADR-0049's stated intent), documented as an SDK spec and surfaced upstream for a contracts-side blessing. *Protocol-adjacent; worth a conscious nod.*
- **Verification is trust-relative (not a choice so much as a truth to honor).** `'verified'` would mislead — an attacker can attest a matching `contentHash` under their own lens. We report `matches-author` against `resolvedBy`. Flagging because it changes what the SDK can promise.
- **C. Integration-test against the local fork (chain 31337) now.** Unblocks end-to-end validation before the freeze sign-off — the biggest schedule win. **Rec:** yes. *Cost: a concrete cross-repo artifact for the 31337 addresses/ABIs — a published `@efs/deployments` snapshot or a pinned vendored copy, NOT a live cross-repo read in CI (fragile). Pin this before building `chain/`.*
- **D. Beta = TypeScript only;** `@efs/solidity` stays signatures-only. **Rec:** yes (flag if OnionDAO needs the on-chain path sooner).
- **E. Record all three reserved PROPERTYs** (contentType, contentHash, size) per write. **Rec:** yes — cheap relative to the verification + rendering value; keeps depth at 3.
