# ADR-0011: Build on the on-chain tag-exclusion filter (ADR-0048) and folder Overviews

**Status:** Accepted
**Date:** 2026-06-11
**Related:** contracts ADR-0048 (view-layer tag-exclusion filter), ADR-0042 (effective tag weight), ADR-0031 (lenses), ADR-0033 (root containers / recipient-fallback anchors), ADR-0036 (opaque cursor); SDK ADR-0008 (public API/semver)

## Context

The contracts repo merged two features the SDK must build on:

1. **On-chain tag-exclusion directory filter (ADR-0048).** `EFSFileView.getDirectoryPageFiltered(parentAnchor, anchorSchema, attesters, excludeTagDefs, minWeights, cursor, maxItems)` returns a directory page already filtered by a set of `(excludeTagDef, minWeight)` pairs, evaluated as a **union over viewed lenses and over exclude pairs**, inclusive (`weight >= minWeight`), with a folder-vs-file tag-target asymmetry (folders test the ANCHOR UID, files test the PIN-resolved DATA UID). Caps: `attesters` 1–20, `excludeTagDefs` ≤ 8, `maxItems > 0`. A heavily-excluded page can return **empty items with a non-empty cursor** (phase-1 scan budget) — empty ≠ end-of-list.
2. **Folder Overviews.** A markdown `README.md` anchor placed in a folder (or address-container root), tagged `system` **before** placement so it never flashes as a visible untagged item, authored on the top lens, resolved by **exact path** (never a directory scan). File-anchor Overviews were abandoned — Overviews are folder-scoped.

The SDK vendors only EAS ABIs today, has no view-layer ABI, and its `fs.*` bodies are NotImplemented stubs pending the schema freeze. So "build on that" = **additive surface/type/ABI/doc changes now; bodies stay stubs**.

## Decision

Adopt both as additive surface. Four forks resolved:

1. **Filtering rides `ListOptions`, not a new verb.** Add optional `excludes?: readonly (Hex | string)[]` (def-UID or human label resolved to `/tags/<name>`) and `minWeights?: readonly bigint[]`. Non-empty `excludes` routes `fs.list` to `getDirectoryPageFiltered`; empty routes to the unfiltered sibling. Cursors stay opaque and method-bound.
2. **No `visibility` tri-state preset.** Ship only raw `excludes`/`minWeights`, which map 1:1 to the contract. A `'all'|'visible'|'hidden'` preset would invent semantics the contract doesn't model; deferred to a product decision.
3. **No default excludes.** `fs.list` excludes nothing unless asked. Export `SAFETY_EXCLUDES = ['system','nsfw']` for callers (and the reference explorer) that want the "hide system/nsfw" policy. A library that silently hides a caller's own `README.md` is a worse surprise than requiring opt-in.
4. **Overview is a dedicated verb pair.** `fs.overview(path)` → discriminated `OverviewResult` (`none | markdown | binary | too-large`), resolved by exact `[...container, 'README.md']`. `fs.setOverview(container, markdown)` composes the upload pipeline and applies the `system` TAG **before** placement. No new schema/contract/reserved-key — `README.md` + `/tags/system` are the entire convention. `getActiveTagWeight` is **not** vendored (the filter applies the threshold internally; no SDK consumer yet).

Client-side we fail fast on the on-chain caps (≤20 attesters, ≤8 excludes, `maxItems>0`), derive an all-zero `minWeights` vector when omitted (avoids the length-mismatch revert), and the list iterator treats *empty-items + non-empty-cursor* as "keep paging."

The SDK's deployments registry is reconciled against the contracts source-of-truth (drop phantom `redirect` schema + `aliasResolver` contract; add the real schemas/contracts) as a separate, SDK-internal, non-freeze-gated correction.

## Consequences

- All read surface, ABI, helpers, types, and registry work is **buildable now**; only `fs.list`'s filtered body and `fs.setOverview` are freeze-gated (stay stubs with locked signatures).
- The SDK gains its first **view-layer ABI** (`EFSFileView`), vendored hand-written `as const`.
- v1 filter limitations the SDK inherits and documents: reviewer/lens-relative exclusion, LIST items never excluded, cross-lens tagging honored.
- The `excludes`-as-labels path needs `/tags/<name>` resolution before the first filtered call, and must gate the read so it never briefly issues the unfiltered branch (leak window).

## Alternatives

- **A `visibility` preset now** — rejected (#2): invents tri-state semantics over a per-tag-exclusion primitive; revisit when product defines "hidden."
- **Default-hide system/nsfw** — rejected (#3): surprising for a low-level SDK; opt-in via `SAFETY_EXCLUDES`.
- **`fs.read([...path,'README.md'])` instead of `fs.overview()`** — rejected (#4): a dedicated verb carries "absent = none" cleanly and pins the exact-path (no-scan) contract.
