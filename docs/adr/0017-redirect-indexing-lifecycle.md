# ADR-0017: REDIRECT writes complete the EFSIndexer indexing lifecycle

**Status:** Accepted
**Date:** 2026-08-07
**Related:** contracts `EFSIndexer.index/indexRevocation` (permissionless, idempotent), contracts ADR-0066 (`index()` is discovery-only), SDK PR #1 review r3739110406, ADR-0007 (error model)

## Context

`AliasResolver` (REDIRECT) is write-guards-only: it validates and emits but does not populate `EFSIndexer`'s referencing index — while every SDK redirect read (`redirects.get/list/canonical/history`, `fs.locate` symlink following) routes through `getReferencingBySchemaAndAttester`. So a `redirects.set()` was invisible to reads until someone called the permissionless `index(uid)`, and a `remove()`d redirect kept being served (filtered reads key on the INDEXER's revocation mirror, not EAS state) until `indexRevocation(uid)`. Pre-populated test mocks hid the break.

The full resolver sweep (verified in contracts source): **REDIRECT is the only SDK-written schema with this gap.** ANCHOR/DATA/PROPERTY index atomically in `EFSIndexer.onAttest`; PIN/TAG via `EdgeResolver.onAttest → idx.index` (+ `indexRevocation` on revoke); MIRROR via `MirrorResolver` likewise. LIST/LIST_ENTRY are not indexer-indexed, but SDK list reads go exclusively to `ListReader`'s own resolver storage — no gap (generic indexer discovery of list entries is a documented non-goal until a read needs it; `efs.index(uid)` already covers it then). WHITEOUT: no SDK writes.

## Decision

- **`redirects.set()` sends a follow-up `index(uid)` tx by default** (after the attest layer mines — `index` reverts on an unknown UID), appending an `index` step to the receipt and counting the extra signature honestly. **`remove()` waits for the revoke receipt, then sends `indexRevocation(uid)`** (ordering mandatory — it reverts until the revocation is mined) and returns a two-leg `RedirectRemoveReceipt`.
- **Failure keeps the landed UID:** an index-leg failure after the attest/revoke landed throws the typed, recoverable `IndexingIncomplete` (code `PartialBatchFailure`) carrying the UID, the landed leg's receipt/tx, and the repair path. It is distinct from `WriteRevertedError` because nothing is half-WRITTEN — only discovery is pending, and the retry is always safe.
- **`efs.index(uid)` is the public repair verb:** reads EAS + `isIndexed`/`isRevoked` and sends whichever leg is missing (`index()` self-mirrors an existing revocation, so an unindexed UID needs only one tx), else no-ops. Permissionless and **lens-neutral** — indexing never changes the attester, so any funded account (a relayer/sponsor included) may run it without violating the attester-stays-the-user rule.
- **`{ index: false }` opts out** on both verbs for callers that batch/delegate indexing; the caller then owns eventual discovery (a subsequent `get` returns `undefined` with no error — documented, tested).

## Consequences

- Tier-1 `set`/`remove` cost 2 prompts instead of 1 — a correctness necessity (an invisible write is a bug), accepted under correct > easy > fast. A future EIP-5792 adapter folds `remove` into one atomic bundle (`[revoke, indexRevocation]` is safely atomic — the revocation is set before the mirror call executes in the same tx); `set`'s index leg needs the minted UID (embeds `block.timestamp`), so a one-prompt `set` needs a non-atomic 5792 bundle or a helper-contract read-back — noted at the submitter seam, not built.
- The real-indexer fork test (`set → get → remove → get(undefined)`) is the regression; unit mocks now model the index lifecycle honestly.
- `index()` gas is nontrivial (up to ~6 storage pushes in `_indexGlobal`) — archival-grade writes; stated in the namespace doc.

## Alternatives considered

- **Document-and-expose (no auto-index)** — rejected: breaks read-your-writes on the SDK's own `get`; violates correct-before-easy.
- **Read-path EAS fallback** — impossible: EAS has no reverse/referencing index; a `RedirectAttested` log scan is not a bounded read primitive (it may return later as an opt-in off-chain read source).
- **A trailing indexBatch layer inside the layered submitter** — deferred: layers are EAS `multiAttest` units; only redirects need it today, so namespace-local is smaller. Revisit if `fs.write` ever emits REDIRECTs (dedup-sameAs on upload).
