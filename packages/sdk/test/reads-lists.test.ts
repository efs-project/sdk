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
    expect(p1.cursor).toBe('2')
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
