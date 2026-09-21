/**
 * Unit tests for the LIST + SORT read surface (`reads/lists.ts`, `reads/sorts.ts`).
 *
 * Driven through a mock {@link ReadContext} whose `readContract` dispatches on the
 * `ListReader` function name (`getMode`/`length`/`entries`/`countOf`) against an
 * in-memory store. No live chain. Mirrors the mock style of `reads-file.test.ts`.
 *
 * Coverage:
 *   - `get` — decodes the LIST config; `exists:false` for an absent/wrong-schema UID
 *     (a probe, never throws).
 *   - `entries` — the three targetTypes (ANY/ADDR/SCHEMA) decode their target;
 *     insertion order preserved; dedupe honors `allowsDuplicates`; append-only vs
 *     revocable read identically (the view excludes revoked); pagination cursor.
 *   - `length` / `has` — lens-scoped O(1) reads; `has` derives the identityKey per
 *     targetType; `ListNotFound` when no LIST exists.
 *   - lens semantics — first-attester-wins across the resolved lens set; curator
 *     fallback for a no-lens read.
 *   - sorts — every verb throws `NotImplemented` (deferred; SORT_INFO not frozen).
 */

import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { EfsDeployment } from '../src/chain/deployments.js'
import { ListNotFound, NotImplemented } from '../src/errors.js'
import { lens } from '../src/lenses/resolve.js'
import type { ReadContext } from '../src/reads/context.js'
import { getList, listEntries, listHas, listLength } from '../src/reads/lists.js'
import { applySort, getSort } from '../src/reads/sorts.js'

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address
const ZERO = uid(0)

const LIST_READER = addr(0xcc)
const SYSTEM = addr(0xee)
const CURATOR = addr(0xbeef)
const OTHER = addr(0xca11)
const LIST_UID = uid(0x5157)

const SCHEMAS = {
  anchor: uid(0xa),
  property: uid(0xb),
  data: uid(0xc),
  pin: uid(0xd),
  tag: uid(0xe),
  mirror: uid(0xf),
  list: uid(0x100),
  listEntry: uid(0x101),
  redirect: uid(0x102),
}

/** ADDR identity key: address right-aligned in a bytes32. */
const addrKey = (a: Address): Hex =>
  `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as Hex

type RawMode = {
  exists: boolean
  curator: Address
  allowsDuplicates: boolean
  appendOnly: boolean
  targetType: number
  targetSchema: Hex
  maxEntries: bigint
}
type RawEntry = { entryUID: Hex; targetType: number; identityKey: Hex }

/** One list's mock on-chain state: its config + per-attester ordered entries. */
type ListState = {
  mode: RawMode
  /** attester (lowercased) → ordered raw entries (active only — revoked excluded). */
  entriesByAttester: Record<string, RawEntry[]>
}

function deployment(): EfsDeployment {
  return {
    chainId: 31337,
    contracts: {
      eas: addr(0xea51),
      schemaRegistry: addr(0x5),
      indexer: addr(0x1de6),
      router: addr(0x6),
      fileView: addr(0xf17e),
      edgeResolver: addr(0xed6e),
      mirrorResolver: addr(0x9),
      listResolver: addr(0xaa),
      listEntryResolver: addr(0xbb),
      listReader: LIST_READER,
      aliasResolver: addr(0xdd),
      systemAccount: SYSTEM,
    },
    schemas: SCHEMAS,
    transports: {},
  }
}

/** Build a mock ReadContext over an in-memory `ListReader`. */
function makeCtx(
  states: Record<string, ListState>,
  opts: { defaultLens?: Address; account?: Address } = {},
): { ctx: ReadContext; calls: { fn: string; args: readonly unknown[] }[] } {
  const calls: { fn: string; args: readonly unknown[] }[] = []
  const get = (listUID: Hex): ListState | undefined => states[listUID.toLowerCase()]
  const publicClient: ReadContext['publicClient'] = {
    async readContract(args) {
      calls.push({ fn: args.functionName, args: args.args ?? [] })
      const a = (args.args ?? []) as readonly unknown[]
      switch (args.functionName) {
        case 'getMode': {
          const st = get(a[0] as Hex)
          if (!st) {
            return {
              exists: false,
              curator: ZERO as unknown as Address,
              allowsDuplicates: false,
              appendOnly: false,
              targetType: 0,
              targetSchema: ZERO,
              maxEntries: 0n,
            } satisfies RawMode
          }
          return st.mode
        }
        case 'length': {
          const st = get(a[0] as Hex)
          const entries = st?.entriesByAttester[(a[1] as Address).toLowerCase()] ?? []
          return BigInt(entries.length)
        }
        case 'entries': {
          const st = get(a[0] as Hex)
          const all = st?.entriesByAttester[(a[1] as Address).toLowerCase()] ?? []
          const start = Number(a[2] as bigint)
          const len = Number(a[3] as bigint)
          return all.slice(start, start + len)
        }
        case 'countOf': {
          const st = get(a[0] as Hex)
          const all = st?.entriesByAttester[(a[1] as Address).toLowerCase()] ?? []
          const key = (a[2] as Hex).toLowerCase()
          return BigInt(all.filter((e) => e.identityKey.toLowerCase() === key).length)
        }
        default:
          throw new Error(`unexpected functionName ${args.functionName}`)
      }
    },
  }
  const ctx: ReadContext = {
    publicClient,
    deployment: deployment(),
    ...(opts.defaultLens !== undefined ? { defaultLens: opts.defaultLens } : {}),
    ...(opts.account !== undefined ? { account: opts.account } : {}),
  }
  return { ctx, calls }
}

/** A LIST config for the given targetType + flags. */
function mode(over: Partial<RawMode> = {}): RawMode {
  return {
    exists: true,
    curator: CURATOR,
    allowsDuplicates: false,
    appendOnly: false,
    targetType: 0,
    targetSchema: ZERO,
    maxEntries: 0n,
    ...over,
  }
}

// ── get ──────────────────────────────────────────────────────────────────────

describe('lists.get (ListReader.getMode — config + identity, not lens-scoped)', () => {
  it('decodes the LIST config, mapping targetType to the literal union', async () => {
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, allowsDuplicates: true, appendOnly: true, maxEntries: 10n }),
        entriesByAttester: {},
      },
    })
    const cfg = await getList(ctx, LIST_UID)
    expect(cfg).toMatchObject({
      listUID: LIST_UID,
      exists: true,
      curator: CURATOR,
      allowsDuplicates: true,
      appendOnly: true,
      targetType: 'addr',
      maxEntries: 10n,
    })
  })

  it('maps targetType 0/2 to any/schema', async () => {
    const { ctx } = makeCtx({
      [uid(1).toLowerCase()]: { mode: mode({ targetType: 0 }), entriesByAttester: {} },
      [uid(2).toLowerCase()]: {
        mode: mode({ targetType: 2, targetSchema: SCHEMAS.data }),
        entriesByAttester: {},
      },
    })
    expect((await getList(ctx, uid(1))).targetType).toBe('any')
    const schemaCfg = await getList(ctx, uid(2))
    expect(schemaCfg.targetType).toBe('schema')
    expect(schemaCfg.targetSchema).toBe(SCHEMAS.data)
  })

  it('returns exists:false for an absent/wrong-schema UID (a probe, never throws)', async () => {
    const { ctx } = makeCtx({})
    const cfg = await getList(ctx, LIST_UID)
    expect(cfg.exists).toBe(false)
    expect(cfg.listUID).toBe(LIST_UID)
  })
})

// ── entries: target decoding per targetType ────────────────────────────────────

describe('lists.entries (target decoding, order, the three targetTypes)', () => {
  it('ADDR list: decodes identityKey to a checksummed address, in order', async () => {
    const a1 = addr(0x111)
    const a2 = addr(0x222)
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1 }),
        entriesByAttester: {
          [CURATOR.toLowerCase()]: [
            { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(a1) },
            { entryUID: uid(0xe2), targetType: 1, identityKey: addrKey(a2) },
          ],
        },
      },
    })
    const got = await listEntries(() => ctx, LIST_UID).toArray({ limit: 100 })
    expect(got.map((e) => e.target)).toEqual([a1, a2])
    expect(got.every((e) => e.targetKind === 'addr')).toBe(true)
    expect(got.map((e) => e.entryUID)).toEqual([uid(0xe1), uid(0xe2)])
  })

  it('entries scoped to an EXPLICIT lens does NOT fall back to the curator', async () => {
    const ALICE = addr(0xa11ce)
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1 }),
        entriesByAttester: {
          // Only the CURATOR has entries; ALICE (the requested lens) has none.
          [CURATOR.toLowerCase()]: [
            { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(addr(0x111)) },
          ],
        },
      },
    })
    // Reading with explicit lens ALICE must return ALICE's (empty) view — never the
    // curator's entries (that would silently break lens scoping).
    const got = await listEntries(() => ctx, LIST_UID, { lens: ALICE }).toArray({ limit: 100 })
    expect(got).toEqual([])
  })

  it('honors a constructor-level cursor for the initial page (resume without restarting at 0)', async () => {
    const ks = [addr(0x1), addr(0x2), addr(0x3), addr(0x4)]
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1 }),
        entriesByAttester: {
          [CURATOR.toLowerCase()]: ks.map((k, i) => ({
            entryUID: uid(0xe0 + i),
            targetType: 1,
            identityKey: addrKey(k),
          })),
        },
      },
    })
    // Resume at offset 2 (a persisted Page.cursor) — byPage with no per-page cursor and
    // toArray (iterate) must both START there, not restart at 0 and duplicate entries.
    const page = await listEntries(() => ctx, LIST_UID, { cursor: '2' }).byPage({ limit: 10 })
    expect(page.items.map((e) => e.target)).toEqual([ks[2], ks[3]])
    const arr = await listEntries(() => ctx, LIST_UID, { cursor: '2' }).toArray({ limit: 10 })
    expect(arr.map((e) => e.target)).toEqual([ks[2], ks[3]])
  })

  it('rejects a non-positive entries limit (would otherwise loop forever)', async () => {
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: { mode: mode({ targetType: 1 }), entriesByAttester: {} },
    })
    expect(() => listEntries(() => ctx, LIST_UID, { limit: 0 })).toThrow(/positive integer/)
    await expect(listEntries(() => ctx, LIST_UID).byPage({ limit: 0 })).rejects.toThrow(
      /positive integer/,
    )
  })

  it('SCHEMA list: the target is the identityKey UID', async () => {
    const t1 = uid(0xabc)
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 2, targetSchema: SCHEMAS.data }),
        entriesByAttester: {
          [CURATOR.toLowerCase()]: [{ entryUID: uid(0xe1), targetType: 2, identityKey: t1 }],
        },
      },
    })
    const got = await listEntries(() => ctx, LIST_UID).toArray({ limit: 100 })
    expect(got[0]).toMatchObject({ target: t1, targetKind: 'schema' })
  })

  it('ANY list: the target is the opaque member key', async () => {
    const k = uid(0xdeadbeef)
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 0 }),
        entriesByAttester: {
          [CURATOR.toLowerCase()]: [{ entryUID: uid(0xe1), targetType: 0, identityKey: k }],
        },
      },
    })
    const got = await listEntries(() => ctx, LIST_UID).toArray({ limit: 100 })
    expect(got[0]).toMatchObject({ target: k, targetKind: 'any' })
  })
})

// ── dedupe (allowsDuplicates) ──────────────────────────────────────────────────

describe('lists.entries dedupe honors allowsDuplicates', () => {
  const a1 = addr(0x111)
  const dupEntries = {
    [CURATOR.toLowerCase()]: [
      { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(a1) },
      { entryUID: uid(0xe2), targetType: 1, identityKey: addrKey(a1) }, // duplicate target
      { entryUID: uid(0xe3), targetType: 1, identityKey: addrKey(addr(0x222)) },
    ],
  }

  // NB: this exercises the SDK's DEFENSIVE dedupe path. On-chain, ListEntryResolver
  // rejects a duplicate identity key per attester at write time (DuplicateIdentity), and
  // entries() reads a single resolved attester — so a real allowsDuplicates=false list
  // can never contain duplicates. The dedupe is kept as defense for a future multi-attester
  // merge; this test asserts it behaves, not that the on-chain state is reachable.
  it('collapses duplicate targets to first-occurrence when allowsDuplicates=false', async () => {
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, allowsDuplicates: false }),
        entriesByAttester: dupEntries,
      },
    })
    const got = await listEntries(() => ctx, LIST_UID).toArray({ limit: 100 })
    // First occurrence of a1 (entry e1) kept; e2 dropped; e3 kept.
    expect(got.map((e) => e.entryUID)).toEqual([uid(0xe1), uid(0xe3)])
  })

  it('keeps every occurrence when allowsDuplicates=true', async () => {
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, allowsDuplicates: true }),
        entriesByAttester: dupEntries,
      },
    })
    const got = await listEntries(() => ctx, LIST_UID).toArray({ limit: 100 })
    expect(got.map((e) => e.entryUID)).toEqual([uid(0xe1), uid(0xe2), uid(0xe3)])
  })

  // Also a defensive-path test (see note above): a real allowsDuplicates=false list can't
  // hold the cross-page duplicate this constructs — it proves global dedupe would collapse
  // one if a future multi-attester merge ever produced it.
  it('async iteration dedupes globally across pages', async () => {
    // 3 entries, page size 2 → two pages; the duplicate a1 spans pages.
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, allowsDuplicates: false }),
        entriesByAttester: {
          [CURATOR.toLowerCase()]: [
            { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(a1) },
            { entryUID: uid(0xe2), targetType: 1, identityKey: addrKey(addr(0x222)) },
            { entryUID: uid(0xe3), targetType: 1, identityKey: addrKey(a1) }, // dup of e1, next page
          ],
        },
      },
    })
    const out: Hex[] = []
    for await (const e of listEntries(() => ctx, LIST_UID, { limit: 2 })) out.push(e.entryUID)
    expect(out).toEqual([uid(0xe1), uid(0xe2)])
  })
})

// ── append-only vs revocable ───────────────────────────────────────────────────

describe('lists.entries — append-only vs revocable read identically', () => {
  const entries = {
    [CURATOR.toLowerCase()]: [
      { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(addr(0x111)) },
    ],
  }

  it('append-only list surfaces appendOnly:true on the config; entries unchanged', async () => {
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, appendOnly: true }),
        entriesByAttester: entries,
      },
    })
    expect((await getList(ctx, LIST_UID)).appendOnly).toBe(true)
    expect((await listEntries(() => ctx, LIST_UID).toArray({ limit: 10 })).length).toBe(1)
  })

  it('revocable list: the view already excludes revoked entries (none surface)', async () => {
    // The mock store holds ACTIVE entries only (the view drops revoked ones), so a
    // revocable list with a revoked entry simply omits it — same read path.
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, appendOnly: false }),
        entriesByAttester: entries, // the revoked entry is not in the active store
      },
    })
    expect((await getList(ctx, LIST_UID)).appendOnly).toBe(false)
    expect((await listEntries(() => ctx, LIST_UID).toArray({ limit: 10 })).length).toBe(1)
  })
})

// ── pagination ─────────────────────────────────────────────────────────────────

describe('lists.entries pagination (.byPage cursor)', () => {
  it('windows entries and advances/clears the cursor', async () => {
    const mk = (i: number): RawEntry => ({
      entryUID: uid(0xe00 + i),
      targetType: 1,
      identityKey: addrKey(addr(0x1000 + i)),
    })
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, allowsDuplicates: true }),
        entriesByAttester: { [CURATOR.toLowerCase()]: [mk(0), mk(1), mk(2)] },
      },
    })
    const list = listEntries(() => ctx, LIST_UID)
    const p1 = await list.byPage({ limit: 2 })
    expect(p1.items.map((e) => e.entryUID)).toEqual([uid(0xe00), uid(0xe01)])
    expect(p1.cursor).toBe(`2:${CURATOR}`) // offset BOUND to the attester it indexes
    const p2 = await list.byPage({ limit: 2, cursor: p1.cursor })
    expect(p2.items.map((e) => e.entryUID)).toEqual([uid(0xe02)])
    expect(p2.cursor).toBeUndefined()
  })

  it('toArray respects the mandatory limit cap', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      entryUID: uid(0xf00 + i),
      targetType: 1,
      identityKey: addrKey(addr(0x2000 + i)),
    }))
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, allowsDuplicates: true }),
        entriesByAttester: { [CURATOR.toLowerCase()]: many },
      },
    })
    const got = await listEntries(() => ctx, LIST_UID, { limit: 3 }).toArray({ limit: 4 })
    expect(got.length).toBe(4)
  })

  it('toArray rejects a non-finite/fractional/non-positive limit (enforces the cap)', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      entryUID: uid(0xf00 + i),
      targetType: 1,
      identityKey: addrKey(addr(0x2000 + i)),
    }))
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, allowsDuplicates: true }),
        entriesByAttester: { [CURATOR.toLowerCase()]: many },
      },
    })
    // Infinity would otherwise page until the list is exhausted; 1.5 would over-collect
    // (the `>= limit` break fires one entry late). Both must throw, not silently collect.
    for (const bad of [Number.POSITIVE_INFINITY, 1.5, Number.NaN, 0, -1]) {
      await expect(listEntries(() => ctx, LIST_UID).toArray({ limit: bad })).rejects.toThrow(
        /positive integer/,
      )
    }
  })
})

// ── length / has ───────────────────────────────────────────────────────────────

describe('lists.length / lists.has', () => {
  const a1 = addr(0x111)
  function ctxWith() {
    return makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1 }),
        entriesByAttester: {
          [CURATOR.toLowerCase()]: [
            { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(a1) },
            { entryUID: uid(0xe2), targetType: 1, identityKey: addrKey(addr(0x222)) },
          ],
        },
      },
    })
  }

  it('length returns the active-entry count for the resolved attester', async () => {
    const { ctx } = ctxWith()
    expect(await listLength(ctx, LIST_UID)).toBe(2n)
  })

  it('has derives the ADDR identityKey and probes membership (O(1))', async () => {
    const { ctx } = ctxWith()
    expect(await listHas(ctx, LIST_UID, a1)).toBe(true)
    expect(await listHas(ctx, LIST_UID, addr(0x999))).toBe(false)
  })

  it('has rejects a 32-byte target on an addr-mode list (no width-collision false positive)', async () => {
    const { ctx } = ctxWith()
    // `addrKey(a1)` is the exact bytes32 membership key for a1 (24 zero bytes + a1). Under the
    // old truncate+pad this 32-byte value passed through unchanged and falsely matched a1's
    // entry. The width check now rejects a non-20-byte target before computing the key.
    await expect(listHas(ctx, LIST_UID, addrKey(a1))).rejects.toThrow(/20-byte address/)
  })

  it('length throws ListNotFound for an absent list', async () => {
    const { ctx } = makeCtx({})
    await expect(listLength(ctx, LIST_UID)).rejects.toBeInstanceOf(ListNotFound)
  })

  it('has throws ListNotFound for an absent list', async () => {
    const { ctx } = makeCtx({})
    await expect(listHas(ctx, LIST_UID, a1)).rejects.toBeInstanceOf(ListNotFound)
  })

  it('entries throws ListNotFound (on first read) for an absent list', async () => {
    const { ctx } = makeCtx({})
    await expect(listEntries(() => ctx, LIST_UID).toArray({ limit: 10 })).rejects.toBeInstanceOf(
      ListNotFound,
    )
  })
})

// ── lens semantics: first-attester-wins + curator fallback ──────────────────────

describe('lists entry reads — lens semantics (first-attester-wins, curator fallback)', () => {
  const a1 = addr(0x111)

  it('no-lens read falls back to the curator (single-curator list reads its own entries)', async () => {
    // No defaultLens, no account → the lens ladder resolves to SystemAccount, which
    // has no entries; the curator (folded in as a candidate) does → curator wins.
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, curator: CURATOR }),
        entriesByAttester: {
          [CURATOR.toLowerCase()]: [
            { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(a1) },
          ],
        },
      },
    })
    const got = await listEntries(() => ctx, LIST_UID).toArray({ limit: 10 })
    expect(got.map((e) => e.attester)).toEqual([CURATOR])
    expect(got.map((e) => e.target)).toEqual([a1])
  })

  it('first lens attester with entries wins over a later one', async () => {
    // lens = [OTHER, CURATOR]; OTHER has entries → OTHER wins (first with entries).
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, curator: CURATOR }),
        entriesByAttester: {
          [OTHER.toLowerCase()]: [{ entryUID: uid(0xe9), targetType: 1, identityKey: addrKey(a1) }],
          [CURATOR.toLowerCase()]: [
            { entryUID: uid(0xe1), targetType: 1, identityKey: addrKey(addr(0x222)) },
          ],
        },
      },
    })
    const got = await listEntries(() => ctx, LIST_UID, { lens: lens([OTHER, CURATOR]) }).toArray({
      limit: 10,
    })
    expect(got.map((e) => e.entryUID)).toEqual([uid(0xe9)])
    expect(got.map((e) => e.attester)).toEqual([OTHER])
  })

  it('explicit single-address lens scopes to that attester', async () => {
    const { ctx } = makeCtx({
      [LIST_UID.toLowerCase()]: {
        mode: mode({ targetType: 1, curator: CURATOR }),
        entriesByAttester: {
          [OTHER.toLowerCase()]: [{ entryUID: uid(0xe9), targetType: 1, identityKey: addrKey(a1) }],
        },
      },
    })
    expect(await listLength(ctx, LIST_UID, { lens: OTHER })).toBe(1n)
    // The curator has no entries, so a curator-scoped length is 0.
    expect(await listLength(ctx, LIST_UID, { lens: CURATOR })).toBe(0n)
  })
})

// ── sorts (deferred stub) ──────────────────────────────────────────────────────

describe('sorts.* — deferred (SORT_INFO not frozen): every verb throws NotImplemented', () => {
  it('get throws NotImplemented with a pointer to lists', async () => {
    const err = await getSort(uid(0x501)).catch((e) => e)
    expect(err).toBeInstanceOf(NotImplemented)
    expect((err as NotImplemented).message).toMatch(/SORT_INFO/)
    expect((err as NotImplemented).alternative).toMatch(/lists/i)
  })

  it('apply throws NotImplemented', async () => {
    await expect(applySort(uid(0x1), uid(0x501))).rejects.toBeInstanceOf(NotImplemented)
  })
})

describe('list attester re-selection after a raced revoke (review r3741157007)', () => {
  const A = addr(0xaa1)
  const B = addr(0xbb2)

  /** A hand-rolled client: attester A reports one entry on its FIRST `length`
   * read (the selection probe) and zero afterwards (a revoke landed between the
   * probe and the verb's follow-up read); B holds one entry throughout. */
  /** A is EMPTY (its entries were revoked) unless `aStable`; B always holds one
   * entry. Exercises the live per-candidate failover the verbs perform. */
  function racedClient(opts?: {
    bCountOf?: bigint
    /** Keep A alive (length 1) — the honest-end / standing-leader case. */
    aStable?: boolean
  }): ReadContext['publicClient'] {
    return {
      async readContract(args: { functionName: string; args?: readonly unknown[] }) {
        const a = (args.args ?? []) as readonly unknown[]
        switch (args.functionName) {
          case 'getMode':
            return {
              exists: true,
              curator: CURATOR,
              allowsDuplicates: false,
              appendOnly: false,
              targetType: 0,
              targetSchema: ZERO,
              maxEntries: 0n,
            }
          case 'length': {
            const who = (a[1] as string).toLowerCase()
            // A holds an entry only in the `aStable` variant; otherwise it is
            // empty (its entries were revoked). With the pre-filtering probe
            // gone (r3741898817) every verb reads liveness itself, so the
            // fixture models the STATE rather than a read-ordering trick.
            if (who === A.toLowerCase()) return opts?.aStable ? 1n : 0n
            return who === B.toLowerCase() ? 1n : 0n // B always holds one
          }
          case 'countOf': {
            const who = (a[1] as string).toLowerCase()
            if (who === B.toLowerCase()) return opts?.bCountOf ?? 1n
            return 0n // A's slot evaporated (or never held the target)
          }
          case 'entries': {
            const who = (a[1] as string).toLowerCase()
            const start = a[2] as bigint
            if (who === B.toLowerCase()) {
              // B serves its single entry from offset 0 only.
              return start === 0n ? [{ entryUID: uid(0xe1), identityKey: uid(0x777) }] : []
            }
            return [] // A's entries are gone (or, aStable: past its single entry)
          }
          default:
            throw new Error(`unexpected ${args.functionName}`)
        }
      },
    } as unknown as ReadContext['publicClient']
  }
  const ctxOf = (client: ReadContext['publicClient']): ReadContext =>
    ({ publicClient: client, deployment: deployment() }) as ReadContext

  it('length falls through to the next lens attester (never a false 0)', async () => {
    const ctx = ctxOf(racedClient())
    expect(await listLength(ctx, LIST_UID, { lens: lens([A, B]) })).toBe(1n) // B's count
  })

  it('has() falls through when the leader evaporated — but an honest false STANDS', async () => {
    // Leader evaporated → B is consulted (target present under B → true).
    const ctx = ctxOf(racedClient())
    expect(await listHas(ctx, LIST_UID, uid(0x777), { lens: lens([A, B]) })).toBe(true)
    // Honest false: B is the standing winner (length > 0) but lacks THIS target —
    // first-attester-wins forbids any further fall-through.
    const ctx2 = ctxOf(racedClient({ bCountOf: 0n }))
    expect(await listHas(ctx2, LIST_UID, uid(0x888), { lens: lens([A, B]) })).toBe(false)
  })

  it('an UNBOUND cursor indexes the SELECTED listing, skipping empty candidates (r3741418197)', async () => {
    // A legacy/hand-written numeric cursor carries no attester, so it can only
    // mean "offset into the selection" — the first candidate that actually has
    // entries. A is empty, so the walk reaches B and applies the offset THERE
    // (B holds one entry at index 0, so offset 5 is past its end). The
    // evaporated-LEADER case is expressible only with a bound cursor — see the
    // sibling test (r3741506928).
    const ctx = ctxOf(racedClient())
    const page = await listEntries((() => ctx) as never, LIST_UID, {
      lens: lens([A, B]),
      cursor: '5',
    }).byPage()
    expect(page.items).toHaveLength(0)
    // …and from offset 0 the same walk reaches B's entry.
    const first = await listEntries((() => ctx) as never, LIST_UID, {
      lens: lens([A, B]),
    }).byPage()
    expect(first.items[0]?.attester).toBe(B)
  })

  it('a BOUND cursor whose attester evaporated restarts the ranked walk at 0 — never a foreign offset (r3741506928)', async () => {
    // The cursor was persisted against A's listing; A lost everything and B
    // (with entries) now wins. Applying A's numeric offset to B would silently
    // SKIP B's first entries — the binding voids the cursor instead.
    const ctx = ctxOf(racedClient())
    const page = await listEntries((() => ctx) as never, LIST_UID, {
      lens: lens([A, B]),
      cursor: `5:${A}`,
    }).byPage()
    expect(page.items).toHaveLength(1) // B's listing from offset 0 — nothing skipped
    expect(page.items[0]?.attester).toBe(B)
  })

  it('a B-bound page does NOT move a later UNBOUND read off the ranked leader (r3741791442)', async () => {
    // Selection must be per-request: paging B via a bound cursor, then calling
    // byPage() again with no cursor on the SAME handle, must restart at the
    // first-ranked candidate — not continue from B. Both attesters hold one
    // entry here, so whichever one is read is unambiguous.
    const bothHold: ReadContext['publicClient'] = {
      async readContract(args: { functionName: string; args?: readonly unknown[] }) {
        const a = (args.args ?? []) as readonly unknown[]
        switch (args.functionName) {
          case 'getMode':
            return {
              exists: true,
              curator: CURATOR,
              allowsDuplicates: false,
              appendOnly: false,
              targetType: 0,
              targetSchema: ZERO,
              maxEntries: 0n,
            }
          case 'length':
            return 1n // both A and B hold exactly one entry
          case 'entries': {
            const who = (a[1] as string).toLowerCase()
            const start = a[2] as bigint
            if (start > 0n) return []
            return who === A.toLowerCase()
              ? [{ entryUID: uid(0xea1), identityKey: uid(0xaaa) }]
              : [{ entryUID: uid(0xeb1), identityKey: uid(0xbbb) }]
          }
          default:
            throw new Error(`unexpected ${args.functionName}`)
        }
      },
    } as unknown as ReadContext['publicClient']
    const ctx = ctxOf(bothHold)
    const list = listEntries((() => ctx) as never, LIST_UID, { lens: lens([A, B]) })
    const bound = await list.byPage({ cursor: `0:${B}` })
    expect(bound.items[0]?.attester).toBe(B) // the bound call reads B
    const unbound = await list.byPage()
    // A is ranked first — the unbound call must read A, proving the earlier
    // bound call left no shared selection behind.
    expect(unbound.items[0]?.attester).toBe(A)
  })

  it('an emptied BOUND attester restarts the scan from the TOP, not just forward (r3742009383)', async () => {
    // The first page skipped empty A and selected B; by resume time B is empty
    // and A has gained an entry. Advancing only PAST B would report end-of-list
    // (B is last) — the now-first-ranked A must win.
    const flipped: ReadContext['publicClient'] = {
      async readContract(args: { functionName: string; args?: readonly unknown[] }) {
        const a = (args.args ?? []) as readonly unknown[]
        switch (args.functionName) {
          case 'getMode':
            return {
              exists: true,
              curator: CURATOR,
              allowsDuplicates: false,
              appendOnly: false,
              targetType: 0,
              targetSchema: ZERO,
              maxEntries: 0n,
            }
          case 'length': {
            const who = (a[1] as string).toLowerCase()
            return who === A.toLowerCase() ? 1n : 0n // A gained, B emptied
          }
          case 'entries': {
            const who = (a[1] as string).toLowerCase()
            const start = a[2] as bigint
            if (who === A.toLowerCase() && start === 0n) {
              return [{ entryUID: uid(0xea9), identityKey: uid(0xaaa) }]
            }
            return []
          }
          default:
            throw new Error(`unexpected ${args.functionName}`)
        }
      },
    } as unknown as ReadContext['publicClient']
    const ctx = ctxOf(flipped)
    const page = await listEntries((() => ctx) as never, LIST_UID, {
      lens: lens([A, B]),
      cursor: `3:${B}`, // bound to B, which is now empty
    }).byPage()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.attester).toBe(A) // restarted from the top
  })

  it('a BOUND cursor continues ITS attester even when outranked (no skip, no dup)', async () => {
    // B gained entries and now outranks... rather: the cursor belongs to B's
    // listing; even with A ranked first, the bound cursor continues B at its
    // offset (a continuation token of THAT listing).
    const ctx = ctxOf(racedClient({ aStable: true }))
    const page = await listEntries((() => ctx) as never, LIST_UID, {
      lens: lens([A, B]),
      cursor: `1:${B}`,
    }).byPage()
    // B's single entry sits at offset 0 — resuming at 1 is its honest end.
    expect(page.items).toHaveLength(0)
  })

  it('a RESUMED empty page from a STANDING leader stays the honest end', async () => {
    // A still has entries (the cursor just ran past them) — no fall-through to
    // B; the listing honestly ends.
    const ctx = ctxOf(racedClient({ aStable: true }))
    const page = await listEntries((() => ctx) as never, LIST_UID, {
      lens: lens([A, B]),
      cursor: '5',
    }).byPage()
    expect(page.items).toHaveLength(0)
  })

  it('entries falls through on an empty first page (never a false empty listing)', async () => {
    const ctx = ctxOf(racedClient())
    const page = await listEntries((() => ctx) as never, LIST_UID, { lens: lens([A, B]) }).byPage()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.attester).toBe(B)
  })
})
