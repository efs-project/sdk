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
 * ## Filtered view (excludes / minWeights)
 *
 * TODO(ADR-0011/0054): when `opts.excludes` is non-empty the listing must route to
 * `getDirectoryPageFiltered` (opaque `bytes` cursor, parallel `excludeTagDefs` /
 * `minWeights`, label→tag-definition resolution). That path is intentionally not
 * wired here yet; passing `excludes` throws {@link InvalidDirectoryQuery} rather
 * than silently returning an unfiltered listing (which would leak excluded
 * entries). The unfiltered path below is fully wired.
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { CursorInvalid } from '../errors.js'
import type { DataUID, DirEntry, EfsList, ListOptions, Page } from '../types.js'
import {
  type FileSystemItem,
  type ReadContext,
  ZERO_UID,
  read,
  resolveAttesters,
} from './context.js'
import { InvalidDirectoryQuery, validateDirectoryQuery } from './directory.js'
import { resolvePathToAnchor } from './resolve.js'

/** Default per-page window when the caller passes no `limit`. */
export const DEFAULT_PAGE_SIZE = 50

/** Map one on-chain `FileSystemItem` to a public {@link DirEntry}. */
function toDirEntry(item: FileSystemItem): DirEntry {
  if (item.isFolder) {
    return { name: item.name, kind: 'dir', anchorUID: item.uid as DataUID }
  }
  return { name: item.name, kind: 'file', dataUID: item.uid as DataUID }
}

/** Parse an opaque string cursor into the on-chain `uint256` start index.
 * Empty/absent → 0 (fresh start). Non-numeric → {@link CursorInvalid}. */
function parseCursor(cursor: string | undefined): bigint {
  if (cursor === undefined || cursor === '') return 0n
  if (!/^\d+$/.test(cursor)) throw new CursorInvalid()
  try {
    return BigInt(cursor)
  } catch {
    throw new CursorInvalid()
  }
}

/**
 * Read one page of a directory listing. Resolves the lens + the directory anchor,
 * then windows `getDirectoryPageByAddressList`. Exported for the client to build
 * the {@link EfsList}; not a public verb on its own.
 */
async function readPage(
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
 * `efs.fs.list(dir, opts?)` — the lens-scoped directory listing. Returns an
 * {@link EfsList} synchronously (it is lazy — no RPC until iterated or `.byPage()`d).
 * Deployment, lens, and anchor resolution are ALL deferred into the first read so
 * the synchronous client method never throws — a bad deployment / missing lens
 * surfaces on `.byPage()` / iteration, consistent with the async read verbs. The
 * context is therefore passed as a THUNK, evaluated lazily inside `prime()`.
 *
 * @throws {InvalidDirectoryQuery} when `opts.excludes` is set (filtered view is a
 *   documented TODO — see module docs).
 */
export function list(
  ctxThunk: () => ReadContext,
  dir: string,
  opts?: ListOptions,
): EfsList<DirEntry> {
  // Fail fast on the unsupported filtered path BEFORE any async work, so the error
  // surfaces at call time rather than on first iteration.
  if (opts?.excludes && opts.excludes.length > 0) {
    throw new InvalidDirectoryQuery(
      'Tag-exclusion filtering (opts.excludes) is not wired in fs.list yet — the unfiltered listing would leak excluded entries, so it is refused rather than silently ignored. Omit `excludes` for now.',
    )
  }

  const defaultLimit = opts?.limit ?? DEFAULT_PAGE_SIZE

  // Resolve the context + lens + directory anchor once, lazily + memoized: the
  // first read primes it, later pages reuse it.
  let primed:
    | Promise<{ ctx: ReadContext; parentAnchor: Hex; attesters: readonly Address[] }>
    | undefined
  const prime = () => {
    if (!primed) {
      primed = (async () => {
        const ctx = ctxThunk()
        const attesters = await resolveAttesters(ctx, opts)
        const parentAnchor = await resolvePathToAnchor(
          ctx.publicClient as never,
          ctx.deployment.contracts.indexer,
          dir,
        )
        // Guard the on-chain caps (attesters 1-20) before issuing the page read.
        validateDirectoryQuery({ attesters, excludeTagDefs: [], maxItems: defaultLimit })
        return { ctx, parentAnchor, attesters }
      })()
    }
    return primed
  }

  const byPage = async (pageOpts?: {
    limit?: number
    cursor?: string
  }): Promise<Page<DirEntry>> => {
    const { ctx, parentAnchor, attesters } = await prime()
    const start = parseCursor(pageOpts?.cursor)
    const pageSize = pageOpts?.limit ?? defaultLimit
    return readPage(ctx, parentAnchor, attesters, start, pageSize)
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
