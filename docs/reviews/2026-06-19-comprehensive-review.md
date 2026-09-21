# EFS SDK — Comprehensive Review (2026-06-19)

Five expert passes: architecture/system-design, 50-year future-proofing, dev UX, API completeness, industry standards. Each read the design docs + the built code (`packages/sdk/src`, `packages/solidity/src`) + ADRs + the contracts model.

## Verdict

**The foundation is solid and above ecosystem baseline; the implemented surface is a fraction of the designed one, and there are a handful of real correctness bugs to fix.**

- **Architecture, trust model, error model, standards posture, and the read-a-file/write-a-file core are strong** — model-faithful, genuinely layered (`fs`→`eas`→`raw`), fail-closed trust handling, viem-grade errors, no launch-blocking standards violations in shipped code, and 50-year-conscious public-surface decisions (EIP-1193 boundary, open unions, branded refs, compile-in Solidity).
- **But:** design completeness ≈ 95%, implementation ≈ 35%. The built code is one vertical slice (single-file write + lens-scoped read). Most protocol primitives (tag/property/pin/list/sort/mirror/redirect) are absent, the escape hatches (`eas`/`raw`) are partial, and the Solidity SDK covers 2 of 9 schemas. The design won't fight the missing pieces (they're additive namespaces), but "a dev can do *everything* easily" is not yet true.

## P1 — fix before relying on it

**Correctness bugs (small, clear fixes):**
1. **`info().verified` reports `'matches-author'` without ever hashing bytes** (`reads/file.ts:280-284`). A false trust signal — a dev building a "verified" badge off `info` mislabels content. Must be `'unchecked'` (the type already allows it); reserve `matches-author`/`mismatch` for paths that actually compared bytes. *(arch P1-1, DX P2-1)*
2. **Written files don't appear in the author's own lens listing** — the ancestor-walk visibility TAGs (overview §7, ADR-0038/0041) are deferred and never emitted on Tier-1 write (`writes/graph.ts`). The one fully-built flow is subtly half-broken. *(completeness P1-2)*
3. **Provenance read swallows RPC errors to zero** (`reads/file.ts:133-145` `.catch(() => {pinUID: ZERO_UID})`) — an "always-present" provenance guarantee that silently empties on a network blip. Distinguish absence from RPC failure. *(arch P1-1)*

**Docs lie (highest-ROI DX fix):**
4. **The package `README.md` quickstart shows the OLD API** (`read`→`fetch`; `fetch` no longer exists; `read` returns bytes now). The first snippet a dev copies doesn't compile. Regenerate from the real surface + add a `tsc` doctest so snippets can't drift. The `docs/specs/overview.md` prose is stale the same way. *(DX P1-1, P3-3)*

**One-liner promise broken for read-only:**
5. **A no-wallet, no-lens read throws `LensRequired`** — you can't read a public file in one line, and it's inconsistent with the router (which falls back to the `system` lens). Ship a `SYSTEM_LENS` default. *(DX P1-3)*

**Present-but-throwing trap:**
6. **`list({ excludes })` throws `InvalidDirectoryQuery`** though it's a documented, typed option with `SAFETY_EXCLUDES` exported as usable. Wire it or remove it from the public type until wired. *(arch P2-1, DX P1-5, completeness P1-3)*

**50-year type durability (trivial fixes, real payoff):**
7. **`CallStatus` and `OperationKind` are CLOSED unions** pinned to EIP-5792's evolving wire format (5792 already broke v1→v2 and carries a `version` field). Add the `| (string & {})` open tail every other union has — this is the export most likely to force a semver-major. *(future-proofing P1-1, P2-1)*
8. **`EfsContracts`/`EfsSchemaUIDs` require all keys** → every future primitive (SORT_INFO freeze, WHITEOUT, new view) is a breaking change *for the `deployments` override path*. Make additive keys optional. *(future-proofing P2-2)*

**Security/trust gate is a TODO:**
9. **`assertDeploymentIntegrity` only checks bytecode presence, not schema-UID match** (`deployments.ts:110-117 TODO`). The read model's trust root (router/view/indexer) is unverified; an arbitrary `deployments` override passes as long as the addresses are contracts. Should be a 1.0 blocker. *(arch P2-4, future-proofing P2-4)*

**Standards one-liner:**
10. **Dead default IPFS gateway** — `cloudflare-ipfs.com` was decommissioned 2024-08; drop it, keep `ipfs.io`/`dweb.link`, consider `trustless-gateway.link`. *(standards P1-2)*

## P2 — completeness build-out (the roadmap to "do everything")

The missing primitives, in rough priority (all additive, builders are mechanical — `graph.ts` proves the pattern):
- **Edge/value writes:** `graph.tags.{add,remove}`, `props.{set,get,list}`, `graph.pins.{place,unplace}` *(completeness P1-1)*.
- **Finish the escape hatches first** (cheap, de-risks everything): `efs.raw.{indexer,router,fileView,…}` pre-wired instances; `efs.eas.{attest,multiAttest,revoke,getAttestation}`; `efs.decode` round-trip bridge *(completeness P1-4)*.
- **Lists + sorts** (contracts deployed & ready to wrap): `lists.{entries,get,create,add}`, `sorts.{read,process}` *(completeness P1-3)*.
- **Mirrors add/remove, overview/setOverview, container browsing (ADR-0033), `versions.ancestors`** *(completeness P2)*.
- **Solidity SDK** read wrappers + tag/property/list writers (today: write-only, 2/9 schemas) *(completeness P1-5)*.
- **Batch / preview / resume** — the headline one-signature UX; resume is type-present but behavior-absent today *(arch P1-2)*.
- Deferred-OK but flag: REDIRECT (write + multi-hop read resolution), WHITEOUT (ADR-0055), multi-chunk on-chain.

## P3 — polish

`info` over-fetches `getActivePinSlot` on the pure-bytes path; `DirEntry` uses `DataUID` for an anchor (add `AnchorUID` brand); `NotImplemented` messages are dead ends (add `alternative`/`tracking`); ship a `bigint` JSON serializer for TanStack/Next; `MAX_LENSES` duplicated; `package.json` drop redundant `"module"`; SSRF DNS-rebinding gap (opt-in resolve-and-pin for Node); EFSLib `contentHash` comment contradicts ADR-0006 (bare digest); top-level export list dumps ~40 internal symbols into the package root.

## Reconsider — RESOLVED: keep `createParents` default `true` (James, 2026-06-19)

The DX reviewer flagged default-`true` as an author-side footgun (a path typo writes a permanent file to the wrong place). **Decision: keep `true`.** No data supports devs expecting failure; the dominant modern mental model is object storage (S3/GCS/R2/Firebase), where writing to a path just works — so auto-create is the *less* surprising default. The downside is minor and recoverable: a typo misplaces the file only in the author's own (lens-scoped) view, and "move it" is a cheap re-PIN (the DATA/bytes are reused; the stray anchor is harmless/shared). Easy-first wins. Zero-cost future mitigation: `preview()` lists the folders that will be created before signing.

## Strengths to preserve (don't regress these)

The fs/eas/raw layering (real, tree-shakeable, narrow-interface seams); the symbolic-ref write DAG shared by both SDKs; pervasive fail-closed trust handling (value-sugar throws, no silent lens truncation, no excluded-entry leaks, SSRF + redirect re-check + size caps); the viem-grade typed error tree; opt-in `expand` + orthogonal `fields` with `expand`-only narrowing; branded `DataRef` carrying chain+attester; type-level write gating; bare-SHA-256 content addressing (correctly defended vs CIDs); the EIP-1193/EIP-155 public boundary.

## Recommended sequence

1. **Correctness + quick durability/docs wins** (P1 #1,3,4,7,10 + the `verified` fix) — small, clearly-correct, ship now.
2. **Visibility-TAG fix (#2)** — correctness; the built write flow needs it.
3. **`SYSTEM_LENS` default (#5) + `excludes` trap (#6)** — DX.
4. **Schema-UID integrity assertion (#9)** — 1.0 trust blocker.
5. **Escape hatches → edge/value writes → lists/sorts** — the completeness roadmap.
6. Tier-2 one-signature writes + the bigger primitives as separate slices.
