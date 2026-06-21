/**
 * Lens-scoped directory listing — `efs.fs.list(dir, opts?)`.
 *
 * Lists the children of a directory anchor, scoped to the lens's attester set, as
 * an {@link EfsList} of {@link DirEntry}: an async-iterable that walks every entry
 * AND exposes `.byPage({limit,cursor})` for one bounded window + `.toArray({limit})`
 * for a bounded materialization (sdk-read-surface §Pagination).
 *
 * ## On-chain read (FROZEN EFSFileView)
 *
 * The unfiltered path uses `EFSFileView.getDirectoryPageByAddressList(parentAnchor,
 * attesters, startingCursor, pageSize)` (EFSFileView.sol:168) — newest-first across
 * the attester list, returning a bare `FileSystemItem[]` plus a `uint256 nextCursor`.
 * It is lens-scoped (the `attesters` argument) and revoked-excluded by the view.
 *
 * ## Pagination / cursor scheme
 *
 * The on-chain cursor is a `uint256` (an index into the contract's append-only
 * child set). The SDK wraps it as an OPAQUE base-10 string cursor on {@link Page}:
 * `cursor` is the stringified `uint256` when more remain, or `undefined` at the
 * end (the contract returns `0` for "no more"). A caller never interprets it; they
 * pass it back verbatim to `.byPage({ cursor })`. A non-numeric cursor is rejected
 * with {@link CursorInvalid} (a cursor from a different query / corrupted state).
 *
 * `limit` (default {@link DEFAULT_PAGE_SIZE}) sizes each underlying read window;
 * `for await` chains windows until the cursor is exhausted.
 *
 * ## DirEntry mapping
 *
 * Each `FileSystemItem` maps to a {@link DirEntry}: `name`, `kind` (`isFolder` →
 * `'dir'`, else `'file'`), and the anchoring UID — `anchorUID` for a dir (the
 * folder's own anchor) or `dataUID` for a file (its placement's DATA UID, the
 * item's `uid`).
 *
 * ## Filtered view (excludes / minWeights) — ADR-0011 / contracts ADR-0054
 *
 * When `opts.excludes` is non-empty the listing routes to the ON-CHAIN
 * `EFSFileView.getDirectoryPageFiltered(parentAnchor, anchorSchema, attesters,
 * excludeTagDefs, minWeights, cursor, maxItems)` — the filter is evaluated entirely
 * on-chain (NOT a client-side overlay), so there is no per-entry tag-read fan-out
 * and no N+1: it is the same single `readContract` per page as the unfiltered path.
 * The contract evaluates each entry against the `(excludeTagDefs[k], minWeights[k])`
 * pairs as a **union over the viewed lenses AND over the pairs** (a sibling is hidden
 * if ANY viewed lens tagged it — or, for a file, tagged any DATA a lens placed there —
 * with ANY excluded def at `weight >= minWeights[k]`), with the folder-vs-file target
 * asymmetry baked in (folders test the ANCHOR UID; files test the PIN-resolved DATA
 * UID). Because the filter is on-chain and lens-scoped via the same `attesters` array,
 * the exclusion is exactly as trustworthy as the listing itself.
 *
 * Three differences from the unfiltered path the body handles:
 *   1. **`excludes` resolution** — each entry is a TAG-definition UID (`0x…`, 32-byte)
 *      passed through verbatim, or a human label (`'system'`/`'nsfw'`) resolved to its
 *      `/tags/<name>` anchor UID via the indexer BEFORE the first filtered read, so the
 *      read never briefly issues the unfiltered branch (no leak window).
 *   2. **`minWeights` reconciliation** — paired 1:1 with the resolved defs; omitted or
 *      length-mismatched ⇒ an all-zero vector ({@link reconcileMinWeights}), which is
 *      the on-chain default ("exclude on any non-negative-weight tag") and avoids the
 *      `excludeTagDefs/minWeights length mismatch` revert.
 *   3. **opaque `bytes` cursor + empty-but-not-done** — the filtered view returns an
 *      opaque `bytes` cursor (not the `uint256` of the address-list variant) and, under
 *      its phase-1 scan budget, can return an EMPTY `items` page with a NON-EMPTY
 *      cursor. Empty ≠ end-of-list — the iterator keeps paging until the cursor is the
 *      empty `0x`. The SDK surfaces the opaque cursor as a hex string on {@link Page}
 *      and feeds it back verbatim; a filtered cursor is only valid back into a filtered
 *      list (it encodes filter state).
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { CursorInvalid } from '../errors.js'
import type { AnchorUID, DataUID, DirEntry, EfsList, ListOptions, Page } from '../types.js'
import {
  type FileSystemItem,
  type ReadContext,
  ZERO_UID,
  read,
  resolveAttesters,
} from './context.js'
import { InvalidDirectoryQuery, reconcileMinWeights, validateDirectoryQuery } from './directory.js'
import { ParentNotFoundError, type ResolvePublicClient, resolvePathToAnchor } from './resolve.js'

/** Default per-page window when the caller passes no `limit`. */
export const DEFAULT_PAGE_SIZE = 50

/** `0x` — the filtered view's "exhausted" cursor sentinel (`bytes`, ADR-0036). The
 * address-list variant's `uint256 0` and this are distinct sentinels for distinct
 * cursor types; both mean "no more pages." */
const EMPTY_BYTES_CURSOR = '0x' as Hex

/** A 32-byte hex UID (`0x` + 64 hex), vs. a `/tags/<name>` human label. */
function isUID(s: string): s is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(s)
}

/**
 * Resolve the `excludes` predicate list to concrete TAG-definition UIDs (ADR-0011 §1):
 * a 32-byte hex UID passes through; a human label (`'system'`, `'nsfw'`, or any
 * `/tags/<name>`/`tags/<name>` form) is resolved to its `/tags/<name>` anchor UID via
 * the indexer path walk — the SAME resolution `efs.graph.tags` uses, so a label means
 * the same def everywhere. Done ONCE before the first filtered read so the read never
 * issues the unfiltered branch first (no leak window).
 *
 * Fails CLOSED on an unresolvable label: if `/tags/<name>` has no anchor on this
 * deployment, we throw {@link InvalidDirectoryQuery} naming the label rather than
 * degrade to a zero UID. A zero exclude-def matches nothing on-chain, so degrading
 * would silently return an UNFILTERED listing for a predicate the caller asked to
 * exclude — a leak for a safety filter. Explicit error > silent leak. (Callers who
 * want "exclude if it exists, else ignore" can resolve the def themselves and pass
 * the UID form.)
 */
async function resolveExcludeDefs(
  publicClient: ResolvePublicClient,
  indexer: Address,
  excludes: readonly (Hex | string)[],
): Promise<Hex[]> {
  return Promise.all(
    excludes.map(async (e) => {
      if (isUID(e)) return e
      const label = e.startsWith('/tags/')
        ? e
        : e.startsWith('tags/')
          ? `/${e}`
          : `/tags/${e.replace(/^\/+/, '')}`
      try {
        return await resolvePathToAnchor(publicClient, indexer, label)
      } catch (err) {
        if (err instanceof ParentNotFoundError) {
          throw new InvalidDirectoryQuery(
            `Unknown exclude tag "${e}": no anchor at "${label}" on this deployment. Pass an existing /tags/<name> label or a 32-byte tag-definition UID.`,
          )
        }
        throw err
      }
    }),
  )
}

/** Map one on-chain `FileSystemItem` to a public {@link DirEntry}. */
function toDirEntry(item: FileSystemItem): DirEntry {
  if (item.isFolder) {
    return { name: item.name, kind: 'dir', anchorUID: item.uid as AnchorUID }
  }
  return { name: item.name, kind: 'file', dataUID: item.uid as DataUID }
}

/** Parse an opaque string cursor into the on-chain `uint256` start index
 * (UNFILTERED path). Empty/absent → 0 (fresh start). Non-numeric → {@link
 * CursorInvalid} (a cursor from a different query / corrupted state — notably a
 * `0x…` filtered cursor fed into the unfiltered path). */
function parseCursor(cursor: string | undefined): bigint {
  if (cursor === undefined || cursor === '') return 0n
  if (!/^\d+$/.test(cursor)) throw new CursorInvalid()
  try {
    return BigInt(cursor)
  } catch {
    throw new CursorInvalid()
  }
}

/** Validate + pass through the opaque `bytes` cursor (FILTERED path). Empty/absent →
 * `0x` (a fresh walk). Must be `0x`-prefixed even-length hex — a base-10 cursor from
 * the unfiltered path (no `0x`) is rejected with {@link CursorInvalid}, so the two
 * cursor types never silently cross between the filtered/unfiltered calls. */
function parseBytesCursor(cursor: string | undefined): Hex {
  if (cursor === undefined || cursor === '') return EMPTY_BYTES_CURSOR
  if (!/^0x([0-9a-fA-F]{2})*$/.test(cursor)) throw new CursorInvalid()
  return cursor as Hex
}

/**
 * Read one UNFILTERED page (`getDirectoryPageByAddressList`): newest-first across the
 * attester list, `uint256` cursor (0 ⇒ exhausted). Used when `excludes` is absent.
 */
async function readUnfilteredPage(
  ctx: ReadContext,
  parentAnchor: Hex,
  attesters: readonly Address[],
  start: bigint,
  pageSize: number,
): Promise<Page<DirEntry>> {
  const result = await read<{ items: readonly FileSystemItem[]; nextCursor: bigint }>(
    ctx.publicClient,
    {
      address: ctx.deployment.contracts.fileView,
      abi: fileViewAbi,
      functionName: 'getDirectoryPageByAddressList',
      args: [parentAnchor, attesters, start, BigInt(pageSize)],
    },
  )
  const items = result.items.filter((it) => it.uid !== ZERO_UID).map(toDirEntry)
  // The contract returns 0 for "no more entries"; surface that as no cursor.
  const cursor = result.nextCursor > 0n ? result.nextCursor.toString() : undefined
  return cursor !== undefined ? { items, cursor } : { items }
}

/**
 * Read one FILTERED page (`getDirectoryPageFiltered`, ADR-0011/0054): the on-chain
 * tag-exclusion filter, lens-scoped via `attesters`, scoped to the **DATA** anchor-
 * schema bucket. The `anchorSchema` arg is the `forSchema` BUCKET KEY the walk scans
 * (`_childrenBySchema[parent][anchorSchema]` in phase 1) AND the folder-visibility tag
 * `definition` it qualifies tagged subfolders by (phase 0) — NOT the schema of the
 * anchor attestation itself. SDK-written file anchors are bucketed under
 * `schemas.data` (DATA_SCHEMA_UID — see `writes/graph.ts buildFileAnchor`) and folder-
 * visibility tags are minted with `definition = DATA_SCHEMA_UID`, so passing the
 * ANCHOR schema UID here would scan an empty bucket and return no files. This matches
 * the production client (`getDirectoryPageFiltered(parent, dataSchemaUID, …)`).
 *
 * The cursor is OPAQUE `bytes` (a phase/index triple, ADR-0036): `0x` ⇒ exhausted,
 * anything else ⇒ keep paging — even when `items` is empty (the phase-1 scan budget
 * can yield an empty page mid-walk; empty ≠ end). The opaque cursor is carried verbatim
 * as a hex string on {@link Page}.
 */
async function readFilteredPage(
  ctx: ReadContext,
  parentAnchor: Hex,
  attesters: readonly Address[],
  excludeTagDefs: readonly Hex[],
  minWeights: readonly bigint[],
  cursor: Hex,
  maxItems: number,
): Promise<Page<DirEntry>> {
  const page = await read<{ items: readonly FileSystemItem[]; nextCursor: Hex }>(ctx.publicClient, {
    address: ctx.deployment.contracts.fileView,
    abi: fileViewAbi,
    functionName: 'getDirectoryPageFiltered',
    args: [
      parentAnchor,
      // The DATA-schema bucket key (NOT the ANCHOR schema): file anchors are stored
      // under `_childrenBySchema[parent][DATA_SCHEMA_UID]` and folder-visibility tags
      // key on `definition = DATA_SCHEMA_UID`. See the function doc above.
      ctx.deployment.schemas.data,
      attesters,
      excludeTagDefs,
      minWeights,
      cursor,
      BigInt(maxItems),
    ],
  })
  const items = page.items.filter((it) => it.uid !== ZERO_UID).map(toDirEntry)
  // Empty bytes (`0x`) is the exhausted sentinel; any other cursor means keep paging,
  // EVEN IF `items` is empty (phase-1 budget) — empty != end-of-list (ADR-0011).
  const next = page.nextCursor !== EMPTY_BYTES_CURSOR ? page.nextCursor : undefined
  return next !== undefined ? { items, cursor: next } : { items }
}

/** The primed listing state: the resolved context, anchor, lens, and — when
 * `excludes` was given — the resolved exclude defs + reconciled weights. `filtered`
 * is the routing discriminant (ADR-0011 §1). */
type PrimedList = {
  ctx: ReadContext
  parentAnchor: Hex
  attesters: readonly Address[]
} & (
  | { filtered: false }
  | { filtered: true; excludeTagDefs: readonly Hex[]; minWeights: readonly bigint[] }
)

/**
 * `efs.fs.list(dir, opts?)` — the lens-scoped directory listing. Returns an
 * {@link EfsList} synchronously (it is lazy — no RPC until iterated or `.byPage()`d).
 * Deployment, lens, anchor resolution, AND (for the filtered path) the
 * `excludes`-label resolution are ALL deferred into the first read so the
 * synchronous client method never throws — a bad deployment / missing lens / cap
 * violation surfaces on `.byPage()` / iteration, consistent with the async read
 * verbs. The context is therefore passed as a THUNK, evaluated lazily inside
 * `prime()`.
 *
 * When `opts.excludes` is non-empty the listing routes to the ON-CHAIN
 * `getDirectoryPageFiltered` (the filter is server-side, not a client-side overlay
 * — no per-entry tag fan-out); otherwise the unfiltered sibling is used. The two
 * paths return DIFFERENT cursor types (opaque `bytes` vs `uint256`), so a cursor
 * from a filtered list is only valid back into a filtered list (ADR-0011 §Decision).
 *
 * @throws {InvalidDirectoryQuery} (on first read) when a cap is violated (attesters
 *   1-20, excludes ≤ 8, maxItems > 0).
 */
export function list(
  ctxThunk: () => ReadContext,
  dir: string,
  opts?: ListOptions,
): EfsList<DirEntry> {
  const defaultLimit = opts?.limit ?? DEFAULT_PAGE_SIZE
  const wantFiltered = (opts?.excludes?.length ?? 0) > 0

  // Resolve the context + lens + directory anchor (+ exclude defs) once, lazily +
  // memoized: the first read primes it, later pages reuse it.
  let primed: Promise<PrimedList> | undefined
  const prime = (): Promise<PrimedList> => {
    if (!primed) {
      primed = (async (): Promise<PrimedList> => {
        const ctx = ctxThunk()
        const attesters = await resolveAttesters(ctx, opts)
        // Resolve the exclude labels → def UIDs BEFORE the anchor walk so a filtered
        // read never issues the unfiltered branch first (no leak window). For the
        // unfiltered path this is skipped.
        const excludeTagDefs = wantFiltered
          ? await resolveExcludeDefs(
              ctx.publicClient as unknown as ResolvePublicClient,
              ctx.deployment.contracts.indexer,
              opts?.excludes ?? [],
            )
          : []
        const parentAnchor = await resolvePathToAnchor(
          ctx.publicClient as never,
          ctx.deployment.contracts.indexer,
          dir,
        )
        // Guard the on-chain caps (attesters 1-20, excludes ≤ 8, maxItems > 0)
        // before issuing the page read.
        validateDirectoryQuery({ attesters, excludeTagDefs, maxItems: defaultLimit })
        if (wantFiltered) {
          // Pair a weight threshold to each def; omitted/mismatched ⇒ all-zero.
          const minWeights = reconcileMinWeights(excludeTagDefs, opts?.minWeights)
          return { ctx, parentAnchor, attesters, filtered: true, excludeTagDefs, minWeights }
        }
        return { ctx, parentAnchor, attesters, filtered: false }
      })()
    }
    return primed
  }

  const byPage = async (pageOpts?: {
    limit?: number
    cursor?: string
  }): Promise<Page<DirEntry>> => {
    // Validate a per-page limit override too — the constructor only validated the
    // default. A `limit <= 0` is the contract's `maxItems` revert / a non-progressing
    // empty page; surface the SDK's typed error instead.
    if (
      pageOpts?.limit !== undefined &&
      (!Number.isInteger(pageOpts.limit) || pageOpts.limit <= 0)
    ) {
      throw new InvalidDirectoryQuery(
        `maxItems must be a positive integer (got ${pageOpts.limit}).`,
      )
    }
    const p = await prime()
    const pageSize = pageOpts?.limit ?? defaultLimit
    // No per-page cursor ⇒ fall back to the constructor-level `opts.cursor`, so a caller
    // resuming via `list(path, { cursor })` starts there instead of restarting at offset 0.
    const cursorIn = pageOpts?.cursor ?? opts?.cursor
    if (p.filtered) {
      // The filtered cursor is opaque `bytes` (hex), fed back verbatim; empty/absent
      // ⇒ a fresh `0x` walk.
      const cursor = parseBytesCursor(cursorIn)
      return readFilteredPage(
        p.ctx,
        p.parentAnchor,
        p.attesters,
        p.excludeTagDefs,
        p.minWeights,
        cursor,
        pageSize,
      )
    }
    const start = parseCursor(cursorIn)
    return readUnfilteredPage(p.ctx, p.parentAnchor, p.attesters, start, pageSize)
  }

  async function* iterate(): AsyncGenerator<DirEntry> {
    let cursor: string | undefined
    do {
      const p: Page<DirEntry> = await byPage(
        cursor !== undefined ? { limit: defaultLimit, cursor } : { limit: defaultLimit },
      )
      for (const entry of p.items) yield entry
      cursor = p.cursor
    } while (cursor !== undefined)
  }

  /** Materialize entries up to a MANDATORY `limit` — collect-all needs an explicit
   * cap (sdk-read-surface §4). Walks pages (coalesced) until `limit` is reached or
   * the listing is exhausted. */
  const toArray = async (arrOpts: { limit: number }): Promise<DirEntry[]> => {
    // The mandatory cap must be a finite positive integer. Without this guard,
    // `Infinity` makes `remaining` infinite and `Math.min(defaultLimit, remaining)`
    // collapses to a normal page size — so the loop silently materializes the WHOLE
    // directory instead of rejecting an unbounded collect-all. (`Number.isInteger`
    // also rejects `NaN`/fractional limits.)
    if (!Number.isInteger(arrOpts.limit) || arrOpts.limit <= 0) {
      throw new InvalidDirectoryQuery(
        `toArray limit must be a positive integer (got ${arrOpts.limit}).`,
      )
    }
    const out: DirEntry[] = []
    let cursor: string | undefined
    do {
      const remaining = arrOpts.limit - out.length
      if (remaining <= 0) break
      const p: Page<DirEntry> = await byPage(
        cursor !== undefined
          ? { limit: Math.min(defaultLimit, remaining), cursor }
          : { limit: Math.min(defaultLimit, remaining) },
      )
      for (const entry of p.items) {
        if (out.length >= arrOpts.limit) break
        out.push(entry)
      }
      cursor = p.cursor
    } while (cursor !== undefined && out.length < arrOpts.limit)
    return out
  }

  return {
    [Symbol.asyncIterator]: iterate,
    byPage,
    toArray,
  }
}
