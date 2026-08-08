/**
 * Lens-scoped LIST reads — `efs.lists.*` (curated collections; ADR-0044/0046).
 *
 * A LIST is a named, curator-owned collection of targets (addresses, attestation
 * UIDs of one schema, or opaque member keys). Entries are per-attester (open
 * curation: many attesters can contribute to the same LIST UID), append-only or
 * revocable, and deduped per the list's `allowsDuplicates` rule. The read surface
 * mirrors the file reads' shape (plain serializable DTOs, lens ladder, fail-closed
 * cardinality) while honoring the list-specific semantics.
 *
 * ## On-chain reads (FROZEN schemas, redeployable ListReader — ADR-0044 §5)
 *
 *   - `ListReader.getMode(listUID) -> ListMode` — decodes the LIST attestation
 *     DIRECTLY from EAS, **schema-checked before decode** (a non-LIST UID returns
 *     `exists:false`, never a spoofed config — closes the fake-mode attack). NOT
 *     lens-scoped: the config is the curator's own declaration, read by UID.
 *   - `ListReader.length(listUID, attester) -> uint256` — O(1) active-entry count
 *     for one contributing attester.
 *   - `ListReader.entries(listUID, attester, start, len) -> Entry[]` — a page of
 *     active entries in INSERTION order, read inline from `EntryRecord[]` storage
 *     (zero per-entry `getAttestation` calls). Each `Entry` is `{ entryUID, uint8
 *     targetType, identityKey }`, with `targetType` denormalized from the LIST.
 *   - `ListReader.countOf(listUID, attester, identityKey) -> uint256` — O(1)
 *     membership count (compare `> 0`; ADR-0044 §5 — no `isMember` bool).
 *
 * ## Lens semantics (per verb)
 *
 *   - `get(listUID)` — **NOT lens-scoped.** `getMode` reads the LIST attestation by
 *     UID; the returned `curator` is that attestation's attester. A `lens` opt is
 *     accepted for API symmetry but does not change the result.
 *   - `entries` / `length` / `has` — **lens-scoped, first-attester-wins.** The lens
 *     resolves to an ordered attester set (the shared ladder: `opts.lens` →
 *     `defaultLens` → wallet → SystemAccount). The on-chain reads key on a SINGLE
 *     `attester`, and list curation is per-attester, so the SDK resolves the FIRST
 *     attester in the lens that has any entries (mirroring file placement's
 *     first-wins). When the lens omits/defaults and the list has a curator, the
 *     curator is folded in as a sensible default attester (a single-curator list
 *     reads its own entries with no lens knowledge).
 *
 * ## Dedupe (`allowsDuplicates`)
 *
 * `entries()` honors the list's `allowsDuplicates`: when `false`, repeated targets
 * (same `identityKey`) are collapsed to their FIRST occurrence (insertion order
 * preserved). When `true`, every occurrence is returned. The on-chain `entries`
 * read does NOT dedupe (it returns raw `EntryRecord[]`), so the SDK applies the rule
 * after decode — across the FULL resolved set for `.toArray()` / iteration, and
 * within each window for `.byPage()` (a page-local view; see the cursor note).
 *
 * ## append-only vs revocable
 *
 * Both modes read identically here — the view already excludes revoked entries
 * (`ListEntryResolver` drops them from `EntryRecord[]`). The distinction is exposed
 * on {@link ListConfig.appendOnly} so a UI can hide a "remove" affordance for an
 * append-only list; the read path needs no branch.
 */

import type { Address, Hex } from 'viem'
import { getAddress } from 'viem'
import { listReaderAbi } from '../chain/abi/listReader.js'
import { CursorInvalid, EfsError, ListNotFound } from '../errors.js'
import type {
  EfsList,
  ListConfig,
  ListEntry,
  ListGetOptions,
  ListReadOptions,
  ListTargetType,
  Page,
} from '../types.js'
import { type ReadContext, type ReadPublicClient, read, resolveAttesters } from './context.js'

/** Default per-page window when the caller passes no `limit` (mirrors `list`). */
export const DEFAULT_LIST_PAGE_SIZE = 50

/** Map the on-chain `uint8 targetType` (0=ANY,1=ADDR,2=SCHEMA) to the literal union. */
function toTargetType(raw: number | bigint): ListTargetType {
  switch (Number(raw)) {
    case 1:
      return 'addr'
    case 2:
      return 'schema'
    default:
      // 0 (ANY) and any unexpected value fall back to the opaque member-key kind —
      // never throws (a read must surface SOMETHING renderable, not blow up on a
      // future targetType).
      return 'any'
  }
}

/** The raw `ListMode` tuple `ListReader.getMode` returns (named tuple → object). */
type RawListMode = {
  exists: boolean
  curator: Address
  allowsDuplicates: boolean
  appendOnly: boolean
  targetType: number
  targetSchema: Hex
  maxEntries: bigint
}

/** One raw `Entry` from `ListReader.entries` (`{entryUID, uint8 targetType, identityKey}`). */
type RawEntry = { entryUID: Hex; targetType: number; identityKey: Hex }

/**
 * Decode an entry's `identityKey` to its public target per the (denormalized)
 * targetType. ADDR → the address right-aligned in the key (`bytes32(uint160(a))`,
 * checksummed); SCHEMA → the UID is the key; ANY → the opaque member key is the key.
 * Pure — no I/O (the denormalized `targetType` + `identityKey` are all we need; the
 * typed `targetAsX` accessors exist for callers who want a re-validated read, but
 * cost a `getAttestation` each, so the bulk path decodes inline).
 */
function decodeTarget(kind: ListTargetType, identityKey: Hex): Address | Hex {
  if (kind === 'addr') {
    // The address occupies the low 20 bytes (last 40 hex chars) of the 32-byte key.
    return getAddress(`0x${identityKey.slice(-40)}`)
  }
  return identityKey
}

/** Read + decode the LIST config (`getMode`). Not lens-scoped. */
async function readConfig(
  client: ReadPublicClient,
  listReader: Address,
  listUID: Hex,
): Promise<ListConfig> {
  const m = await read<RawListMode>(client, {
    address: listReader,
    abi: listReaderAbi,
    functionName: 'getMode',
    args: [listUID],
  })
  return {
    listUID,
    exists: m.exists,
    curator: m.curator,
    allowsDuplicates: m.allowsDuplicates,
    appendOnly: m.appendOnly,
    targetType: toTargetType(m.targetType),
    targetSchema: m.targetSchema,
    maxEntries: m.maxEntries,
  }
}

/**
 * Resolve the contributing attester for the lens-scoped entry reads: the FIRST
 * lens attester that has any entries for this list (first-attester-wins), or the
 * first resolved attester when none has entries (so an empty list still resolves to
 * a stable attester rather than throwing). The curator is folded in as a last
 * candidate so a single-curator list reads its own entries with no lens knowledge.
 *
 * One `length` read per candidate, fanned with `Promise.all` (multicall-coalesced),
 * then the first non-zero wins.
 */
async function resolveListAttesters(
  ctx: ReadContext,
  opts: ListReadOptions | undefined,
  listUID: Hex,
  curator: Address,
): Promise<readonly Address[]> {
  const lens = await resolveAttesters(ctx, opts)
  // The curator is a convenience fallback ONLY when the caller expressed NO lens intent
  // (no per-call lens, no client defaultLens, no connected account) — i.e. the read fell
  // through to the SystemAccount default. When a lens WAS requested, stay strictly scoped
  // to it: returning curator Bob's entries to a caller who asked for lens Alice would
  // silently break the lens model.
  const hasLensIntent =
    opts?.lens !== undefined || ctx.defaultLens !== undefined || ctx.account !== undefined
  const pool = hasLensIntent ? lens : [...lens, curator]
  // Candidates: deduped, order-preserving.
  const candidates: Address[] = []
  const seen = new Set<string>()
  for (const a of pool) {
    const key = a.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push(a)
    }
  }
  const lengths = await Promise.all(
    candidates.map((attester) =>
      read<bigint>(ctx.publicClient, {
        address: ctx.deployment.contracts.listReader,
        abi: listReaderAbi,
        functionName: 'length',
        args: [listUID, attester],
      }),
    ),
  )
  // EVERY candidate with entries, in lens order (r3741157007): the probe and
  // the verb's follow-up read are two reads, so a revoke can empty the leading
  // candidate in between — the verbs RE-CHECK and fall through to the next
  // candidate instead of reporting a false empty/zero/false, preserving
  // first-attester-WITH-ENTRIES. Fallback: the first candidate (stable, empty).
  const withEntries = candidates.filter((_, i) => (lengths[i] ?? 0n) > 0n)
  return withEntries.length > 0 ? withEntries : [candidates[0] as Address]
}

/** Read one raw `entries` page for a resolved attester. */
async function readEntriesPage(
  ctx: ReadContext,
  listUID: Hex,
  attester: Address,
  kind: ListTargetType,
  start: bigint,
  len: number,
): Promise<ListEntry[]> {
  const raw = await read<readonly RawEntry[]>(ctx.publicClient, {
    address: ctx.deployment.contracts.listReader,
    abi: listReaderAbi,
    functionName: 'entries',
    args: [listUID, attester, start, BigInt(len)],
  })
  return raw.map((e) => ({
    entryUID: e.entryUID,
    targetKind: kind,
    target: decodeTarget(kind, e.identityKey),
    attester,
  }))
}

/** Reject a non-positive page limit: a `limit <= 0` makes `byPage` return an empty
 * page with the cursor unchanged, so iteration/`toArray` never progresses (an infinite
 * loop). Mirrors the directory-listing path's `maxItems > 0` guard. */
function assertPositiveLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new EfsError(`efs.lists.entries: limit must be a positive integer (got ${limit}).`, {
      code: 'InvalidArgument',
    })
  }
}

/** Parse an opaque cursor. Format: `<offset>:<attester>` — the attester BINDS
 * the offset to the listing it indexes (r3741506928): a bare numeric offset
 * applied to a DIFFERENT winner after a reselection silently skips that
 * winner's first entries. A legacy bare `<offset>` is accepted and applies to
 * the CURRENT selection (protected only by the empty-page disambiguation).
 * Empty → 0. Malformed → {@link CursorInvalid}. */
function parseCursor(cursor: string | undefined): { start: bigint; attester?: Address } {
  if (cursor === undefined || cursor === '') return { start: 0n }
  const m = /^(\d+)(?::(0x[0-9a-fA-F]{40}))?$/.exec(cursor)
  if (!m) throw new CursorInvalid()
  try {
    return {
      start: BigInt(m[1] as string),
      ...(m[2] !== undefined ? { attester: m[2] as Address } : {}),
    }
  } catch {
    throw new CursorInvalid()
  }
}

/** Derive this request's selection from a BOUND cursor: still ranked ⇒
 * continue ITS listing at the cursor's offset (the cursor is a continuation
 * token of THAT listing — no skip, no duplicate, even if a higher-priority
 * attester has since gained entries); gone from the candidate set ⇒ the cursor
 * is void — restart the ranked walk at offset 0 rather than silently applying
 * a foreign offset to the new winner (r3741506928). */
function alignCursor(
  parsed: { start: bigint; attester?: Address },
  candidates: readonly Address[],
): { start: bigint; i: number } {
  // PURE (r3741791442): selection is derived PER REQUEST from the cursor, never
  // carried in shared primed state — an `EfsList` handle can be paged, iterated
  // and `toArray`'d independently, and a B-bound cursor on one call must not
  // silently move a later UNBOUND call off the first-ranked candidate.
  if (parsed.attester === undefined) return { start: parsed.start, i: 0 }
  const bound = parsed.attester.toLowerCase()
  const idx = candidates.findIndex((c) => c.toLowerCase() === bound)
  // Bound attester still ranked ⇒ continue ITS listing at the offset; gone ⇒
  // the cursor is void, restart the ranked walk at 0.
  return idx >= 0 ? { start: parsed.start, i: idx } : { start: 0n, i: 0 }
}

/** Disambiguate an EMPTY page: `true` iff the attester's listing is genuinely
 * non-empty right now (the empty page is the normal end of pagination), `false`
 * iff the attester EVAPORATED (a revoke landed after the selection probe) and
 * the walk should advance to the next ranked candidate (r3741418197). */
async function attesterStillHasEntries(
  ctx: ReadContext,
  listUID: Hex,
  attester: Address,
): Promise<boolean> {
  const n = await read<bigint>(ctx.publicClient, {
    address: ctx.deployment.contracts.listReader,
    abi: listReaderAbi,
    functionName: 'length',
    args: [listUID, attester],
  })
  return n > 0n
}

/**
 * `efs.lists.get(listUID, opts?)` — the LIST config + identity. Reads `getMode`
 * (schema-checked) and returns a {@link ListConfig}; absence is `exists:false`
 * (never a throw — the cheap probe). Not lens-scoped.
 */
export async function getList(
  ctx: ReadContext,
  listUID: Hex,
  _opts?: ListGetOptions,
): Promise<ListConfig> {
  return readConfig(ctx.publicClient, ctx.deployment.contracts.listReader, listUID)
}

/**
 * `efs.lists.length(listUID, opts?)` — the active-entry count for the resolved lens
 * attester (first-attester-wins). Throws {@link ListNotFound} when no LIST exists at
 * `listUID` (entry reads of a non-existent list are a caller error, not a normal
 * empty — unlike `get`, which probes).
 */
export async function listLength(
  ctx: ReadContext,
  listUID: Hex,
  opts?: ListReadOptions,
): Promise<bigint> {
  const config = await readConfig(ctx.publicClient, ctx.deployment.contracts.listReader, listUID)
  if (!config.exists) throw new ListNotFound(listUID)
  // Walk the ranked candidates: a revoke between the selection probe and this
  // read can empty the leader — fall through instead of reporting a false 0.
  for (const attester of await resolveListAttesters(ctx, opts, listUID, config.curator)) {
    const n = await read<bigint>(ctx.publicClient, {
      address: ctx.deployment.contracts.listReader,
      abi: listReaderAbi,
      functionName: 'length',
      args: [listUID, attester],
    })
    if (n > 0n) return n
  }
  return 0n
}

/**
 * `efs.lists.has(listUID, target, opts?)` — O(1) membership probe for the resolved
 * lens attester. `target` is an `Address` (an ADDR list) or a UID/member-key `Hex`
 * (SCHEMA/ANY); the SDK derives the on-chain `identityKey` per the list's
 * targetType. Throws {@link ListNotFound} when no LIST exists.
 */
export async function listHas(
  ctx: ReadContext,
  listUID: Hex,
  target: Address | Hex,
  opts?: ListReadOptions,
): Promise<boolean> {
  const config = await readConfig(ctx.publicClient, ctx.deployment.contracts.listReader, listUID)
  if (!config.exists) throw new ListNotFound(listUID)
  const identityKey = identityKeyFor(config.targetType, target)
  for (const attester of await resolveListAttesters(ctx, opts, listUID, config.curator)) {
    const count = await read<bigint>(ctx.publicClient, {
      address: ctx.deployment.contracts.listReader,
      abi: listReaderAbi,
      functionName: 'countOf',
      args: [listUID, attester, identityKey],
    })
    if (count > 0n) return true
    // countOf 0 splits two ways: the winner STANDS but lacks the target (an
    // honest `false` — first-attester-wins forbids falling through), or the
    // winner EVAPORATED between the probe and this read (its whole list is now
    // empty — try the next candidate).
    const n = await read<bigint>(ctx.publicClient, {
      address: ctx.deployment.contracts.listReader,
      abi: listReaderAbi,
      functionName: 'length',
      args: [listUID, attester],
    })
    if (n > 0n) return false
  }
  return false
}

/**
 * Derive the on-chain `identityKey` for a public target, per targetType. ADDR →
 * `bytes32(uint160(addr))` (address right-aligned); SCHEMA/ANY → the UID/member key
 * IS the key (already a `bytes32`). Pure (the contract's `identityKeyForX` helpers
 * are the same conversions; done locally to avoid a round-trip).
 */
function identityKeyFor(kind: ListTargetType, target: Address | Hex): Hex {
  if (kind === 'addr') {
    // `Address | Hex` is not runtime-distinguished, so without a width check a 32-byte UID
    // whose trailing 20 bytes happen to match a listed address would be silently truncated +
    // re-padded into a COLLIDING key — a false `true` for the wrong target kind. Reject
    // non-address width before computing the key, mirroring the write-side
    // `validateAddTarget('addr', …)` (a plain 20-byte-hex check, address(0) allowed).
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
      throw new EfsError(
        `efs.lists.has: an 'addr'-mode list needs a 20-byte address target; got '${target}'.`,
        { code: 'InvalidArgument' },
      )
    }
    // Right-align the 20-byte address in a 32-byte word.
    const addr = target.toLowerCase().replace(/^0x/, '')
    return `0x${addr.padStart(64, '0')}` as Hex
  }
  return target as Hex
}

/**
 * `efs.lists.entries(listUID, opts?)` — the lens-scoped, ordered, deduped entries as
 * an {@link EfsList}. Lazy (no RPC until iterated / `.byPage()` / `.toArray()`):
 * config + lens resolution are deferred into a memoized `prime()`, so the synchronous
 * call never throws (mirrors `fs.list`). Honors the list's `allowsDuplicates` (dedupe
 * by identity key, first-occurrence-wins) and `targetType` (target decoding).
 *
 * Throws {@link ListNotFound} (on first read) when no LIST exists at `listUID`.
 *
 * NB on dedupe: it is DEFENSIVE today. On-chain `ListEntryResolver` rejects a duplicate
 * identity key per attester at write time, and these reads resolve a single attester, so a
 * real `allowsDuplicates=false` list cannot contain duplicates — the dedupe is a guard for a
 * future multi-attester merge. Given that, the page-local-vs-global split below is currently
 * unobservable; it is kept correct for when merging makes duplicates possible: a page is
 * deduped WITHIN its window, while `.toArray()`/`for await` dedupe globally (`.byPage()` is a
 * windowed read for manual pagers; it also matches the on-chain pages, which are not
 * snapshot-isolated).
 */
export function listEntries(
  ctxThunk: () => ReadContext | Promise<ReadContext>,
  listUID: Hex,
  opts?: ListReadOptions,
): EfsList<ListEntry> {
  assertPositiveLimit(opts?.limit)
  const defaultLimit = opts?.limit ?? DEFAULT_LIST_PAGE_SIZE

  let primed:
    | Promise<{
        ctx: ReadContext
        candidates: readonly Address[]
        kind: ListTargetType
        dedupe: boolean
      }>
    | undefined
  const prime = () => {
    if (!primed) {
      primed = (async () => {
        const ctx = await ctxThunk()
        const config = await readConfig(
          ctx.publicClient,
          ctx.deployment.contracts.listReader,
          listUID,
        )
        if (!config.exists) throw new ListNotFound(listUID)
        const candidates = await resolveListAttesters(ctx, opts, listUID, config.curator)
        // NOTE: no selection index here — each page request derives its own
        // from its cursor (r3741791442), so independent consumers of this
        // handle (byPage / toArray / iteration) never influence each other.
        return {
          ctx,
          candidates,
          kind: config.targetType,
          dedupe: !config.allowsDuplicates,
        }
      })()
    }
    return primed
  }

  /** Page-local dedupe (first occurrence wins) when the list disallows duplicates. */
  const dedupePage = (entries: ListEntry[], dedupe: boolean): ListEntry[] => {
    if (!dedupe) return entries
    const seen = new Set<string>()
    const out: ListEntry[] = []
    for (const e of entries) {
      const key = (e.target as string).toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        out.push(e)
      }
    }
    return out
  }

  const byPage = async (pageOpts?: {
    limit?: number
    cursor?: string
  }): Promise<Page<ListEntry>> => {
    assertPositiveLimit(pageOpts?.limit)
    const { ctx, candidates, kind, dedupe } = await prime()
    // No per-page cursor ⇒ fall back to the constructor-level `opts.cursor` (a caller
    // who persisted a `Page.cursor` and resumed via `entries(uid, { cursor })` must start
    // there, not restart at offset 0 and duplicate entries).
    // Request-LOCAL selection (r3741791442): derived from this call's cursor.
    const aligned = alignCursor(parseCursor(pageOpts?.cursor ?? opts?.cursor), candidates)
    let { start } = aligned
    let i = aligned.i
    const pageSize = pageOpts?.limit ?? defaultLimit
    let page = await readEntriesPage(ctx, listUID, candidates[i] as Address, kind, start, pageSize)
    // An EMPTY page means either the normal end of pagination or an EVAPORATED
    // candidate (a revoke landed after the selection probe). At offset 0 it is
    // always the latter (probe-selected candidates had entries); at a RESUMED
    // offset, disambiguate via a live length read (r3741418197) — a standing
    // leader's empty page is the honest end, an evaporated one falls through to
    // the next ranked candidate, RESTARTING at 0 (the old cursor indexed the
    // evaporated attester's listing and is void for the new one).
    while (page.length === 0 && i + 1 < candidates.length) {
      if (start > 0n && (await attesterStillHasEntries(ctx, listUID, candidates[i] as Address))) {
        break // honest end of the standing leader's listing
      }
      i += 1
      start = 0n
      page = await readEntriesPage(ctx, listUID, candidates[i] as Address, kind, start, pageSize)
    }
    // A short page (fewer than requested) means the end; otherwise advance the cursor
    // by the raw window size (BEFORE page-local dedupe — the on-chain index counts
    // raw entries, not deduped ones).
    // The cursor BINDS its offset to the attester it indexes (r3741506928).
    const next =
      page.length < pageSize
        ? undefined
        : `${(start + BigInt(page.length)).toString()}:${candidates[i]}`
    const items = dedupePage(page, dedupe)
    return next !== undefined ? { items, cursor: next } : { items }
  }

  async function* iterate(): AsyncGenerator<ListEntry> {
    const { dedupe } = await prime()
    // Global dedupe across pages (the per-page byPage dedupe is window-local).
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const p = await byPageRaw(cursor)
      for (const entry of p.items) {
        if (dedupe) {
          const key = (entry.target as string).toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
        }
        yield entry
      }
      cursor = p.cursor
    } while (cursor !== undefined)
  }

  /** Like `byPage` but WITHOUT page-local dedupe — the iterator / `toArray` dedupe
   * globally, so the windowed reads must surface raw entries. */
  const byPageRaw = async (cursor: string | undefined): Promise<Page<ListEntry>> => {
    const { ctx, candidates, kind } = await prime()
    // The first page (cursor undefined) honors the constructor-level `opts.cursor`;
    // subsequent pages thread their own advanced cursor. Selection is
    // request-LOCAL, derived from that cursor (r3741791442) — the iterator's
    // continuity rides the BOUND cursor, not shared state.
    const aligned = alignCursor(parseCursor(cursor ?? opts?.cursor), candidates)
    let { start } = aligned
    let i = aligned.i
    let page = await readEntriesPage(
      ctx,
      listUID,
      candidates[i] as Address,
      kind,
      start,
      defaultLimit,
    )
    // Same evaporated-leader fall-through as byPage, incl. the resumed-offset
    // disambiguation (r3741157007 / r3741418197).
    while (page.length === 0 && i + 1 < candidates.length) {
      if (start > 0n && (await attesterStillHasEntries(ctx, listUID, candidates[i] as Address))) {
        break
      }
      i += 1
      start = 0n
      page = await readEntriesPage(
        ctx,
        listUID,
        candidates[i] as Address,
        kind,
        start,
        defaultLimit,
      )
    }
    const next =
      page.length < defaultLimit
        ? undefined
        : `${(start + BigInt(page.length)).toString()}:${candidates[i]}`
    return next !== undefined ? { items: page, cursor: next } : { items: page }
  }

  const toArray = async (arrOpts: { limit: number }): Promise<ListEntry[]> => {
    // The mandatory materialization cap must be a finite positive integer — the same
    // guard the constructor and `byPage` apply. Without it a fractional limit (1.5)
    // over-collects (the `>= limit` break fires one entry late) and `Infinity` pages
    // until the list is exhausted, defeating the documented cap.
    assertPositiveLimit(arrOpts.limit)
    const { dedupe } = await prime()
    const out: ListEntry[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      if (out.length >= arrOpts.limit) break
      const p = await byPageRaw(cursor)
      for (const entry of p.items) {
        if (out.length >= arrOpts.limit) break
        if (dedupe) {
          const key = (entry.target as string).toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
        }
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
