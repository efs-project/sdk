/**
 * REDIRECT (alias) primitive — the RATIFIED read semantics (contracts specs/09,
 * Accepted / ADR-0067). Covers the pure plan builder, the `efs.redirects.*`
 * verbs, and the read engine: the spec §9 conformance vectors (symlink-only
 * navigation with surfaced-node statuses), selection (first-attester-wins,
 * lowest-UID tie-break, the revoked-newest pagination regression), `sameAs`
 * SCC canonicalization, and the deliberate `supersededBy` walk. No live chain.
 *
 * The mock chain models the indexer FAITHFULLY: `getReferencingBySchemaAndAttester`
 * slices the PHYSICAL window first and filters revoked WITHIN it (mirroring
 * `EFSIndexer._sliceUIDsFiltered`) — the previous mock filtered-then-sliced,
 * which masked the revoked-newest bug the ratified engine fixes.
 */

import {
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { EfsDeployment, EfsSchemaUIDs } from '../src/chain/deployments.js'
import { attestedEventAbi } from '../src/eas/abi.js'
import { SchemaEncoder } from '../src/eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../src/eas/schemas.js'
import {
  IndexSendUnknown,
  IndexUnconfirmed,
  IndexingIncomplete,
  RedirectScanTruncated,
  RevokeUnconfirmed,
} from '../src/errors.js'
import { lens } from '../src/lenses/resolve.js'
import type { ReadContext } from '../src/reads/context.js'
import {
  DEFAULT_REDIRECT_HOPS,
  MAX_REDIRECT_HOPS,
  type RedirectWalkStatus,
  canonicalizeSameAs,
  listLensRedirects,
  resolveHopCap,
  selectLensRedirect,
  walkSupersededBy,
  walkSymlinks,
} from '../src/reads/redirects.js'
import type { EdgeSubmitContext } from '../src/writes/edge-submit.js'
import { REDIRECT_KIND, buildRedirectPlan } from '../src/writes/edge.js'
import { makeRedirectsNs } from '../src/writes/redirects.js'

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address

const SCHEMAS: EfsSchemaUIDs = {
  anchor: uid(0xa),
  property: uid(0xb),
  data: uid(0xc),
  pin: uid(0xd),
  tag: uid(0xe),
  mirror: uid(0xf),
  list: uid(0x10),
  listEntry: uid(0x11),
  redirect: uid(0x12),
}

const EAS = addr(0xea51)
const INDEXER = addr(0x1de7)
const ATTESTER = addr(0xacc01)

const deployment: EfsDeployment = {
  chainId: 11155111,
  schemas: SCHEMAS,
  contracts: {
    eas: EAS,
    schemaRegistry: addr(0x5c),
    indexer: INDEXER,
    router: addr(0x201),
    fileView: addr(0x202),
    edgeResolver: addr(0xed6e),
    mirrorResolver: addr(0x203),
    listResolver: addr(0x204),
    listEntryResolver: addr(0x205),
    listReader: addr(0x206),
    aliasResolver: addr(0x207),
    systemAccount: addr(0x208),
  },
}

const redirectEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.redirect)

/** A REDIRECT attestation `data` blob (`bytes32 target, uint16 kind`). */
function redirectData(target: Hex, kind: number): Hex {
  return redirectEnc.encodeData([target, kind])
}

// ── The honest mock chain ───────────────────────────────────────────────────────
//
// `edges[source]` is the PHYSICAL append-ordered redirect list out of `source`
// (revoked entries stay in the array — the kernel index is append-only).
// `nodes[uid]` types the non-redirect attestations (anchors/DATA) the walker's
// dangling check reads. Unknown getAttestation UIDs return the empty struct
// (uid 0), like EAS.

type Edge = {
  attester: Address
  redirectUID: Hex
  target: Hex
  kind: number
  revoked?: boolean
  /** Simulate a revoke landing BETWEEN the active-only indexer scan and the
   * EAS decode: the scan serves the UID, but getAttestation reports revoked. */
  revokedAfterScan?: boolean
}
type Node = { schema: Hex; revoked?: boolean }

function makeChain(
  edges: Record<string, Edge[]>,
  nodes: Record<string, Node> = {},
): ReadContext['publicClient'] {
  const byUID = new Map<string, Edge>()
  for (const list of Object.values(edges)) {
    for (const e of list) byUID.set(e.redirectUID.toLowerCase(), e)
  }
  return {
    async readContract(a: { functionName: string; args?: readonly unknown[] }) {
      const args = a.args ?? []
      if (a.functionName === 'getReferencingBySchemaAndAttesterCount') {
        const [source, , attester] = args as [Hex, Hex, Address]
        // PHYSICAL count — includes revoked (append-only index).
        return BigInt((edges[source] ?? []).filter((e) => e.attester === attester).length)
      }
      if (a.functionName === 'getReferencingBySchemaAndAttester') {
        const [source, , attester, start, length, reverseOrder, showRevoked] = args as [
          Hex,
          Hex,
          Address,
          bigint,
          bigint,
          boolean,
          boolean,
        ]
        const physical = (edges[source] ?? []).filter((e) => e.attester === attester)
        const ordered = reverseOrder ? [...physical].reverse() : physical
        // _sliceUIDsFiltered: slice the PHYSICAL window FIRST, then filter
        // within it — a page may return fewer than `length` items.
        const window = ordered.slice(Number(start), Number(start + length))
        return window.filter((e) => showRevoked || !e.revoked).map((e) => e.redirectUID)
      }
      if (a.functionName === 'getAttestation') {
        const [u] = args as [Hex]
        const edge = byUID.get(u.toLowerCase())
        if (edge) {
          return {
            uid: u,
            schema: SCHEMAS.redirect,
            revocationTime: edge.revoked || edge.revokedAfterScan ? 1n : 0n,
            data: redirectData(edge.target, edge.kind),
          }
        }
        const node = nodes[u]
        if (node) {
          return {
            uid: u,
            schema: node.schema,
            revocationTime: node.revoked ? 1n : 0n,
            data: '0x' as Hex,
          }
        }
        return { uid: uid(0), schema: uid(0), revocationTime: 0n, data: '0x' as Hex }
      }
      return uid(0)
    },
  } as unknown as ReadContext['publicClient']
}

function ctxWith(client: ReadContext['publicClient']): ReadContext {
  return { publicClient: client, deployment, account: ATTESTER }
}

/** Symlink edge sugar. */
const sym = (attester: Address, redirectUID: Hex, target: Hex, revoked = false): Edge => ({
  attester,
  redirectUID,
  target,
  kind: REDIRECT_KIND.symlink,
  revoked,
})
const anchorNode = (): Node => ({ schema: SCHEMAS.anchor })
const dataNode = (): Node => ({ schema: SCHEMAS.data })

const walk = (
  client: ReadContext['publicClient'],
  entry: Hex,
  attesters: readonly Address[] = [ATTESTER],
  cap = DEFAULT_REDIRECT_HOPS,
) => walkSymlinks(ctxWith(client), { uid: entry, isData: false }, attesters, { remaining: cap })

// ── Pure builder (unchanged write-time shape) ───────────────────────────────────

describe('buildRedirectPlan', () => {
  const FROM = uid(0x100)
  const TO = uid(0x200)

  it('emits one REDIRECT (refUID = source, data = (target, kind)) — one signature', () => {
    const plan = buildRedirectPlan(SCHEMAS, FROM, TO, REDIRECT_KIND.symlink)
    expect(plan.attestations).toHaveLength(1)
    const r = plan.attestations[0]
    expect(r?.kind).toBe('REDIRECT')
    expect(r?.layer).toBe(1)
    expect(r?.schema).toBe(SCHEMAS.redirect)
    expect(r?.revocable).toBe(true) // AliasResolver requires revocable
    expect(r?.refUID).toBe(FROM) // SOURCE rides in refUID
    expect(r?.dataRefs).toEqual([])
    const [target, k] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint16' }],
      r?.data as Hex,
    ) as [Hex, number]
    expect(target).toBe(TO)
    expect(Number(k)).toBe(REDIRECT_KIND.symlink)
  })

  it('defaults kind to sameAs (0)', () => {
    const plan = buildRedirectPlan(SCHEMAS, FROM, TO)
    const [, k] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint16' }],
      plan.attestations[0]?.data as Hex,
    ) as [Hex, number]
    expect(Number(k)).toBe(REDIRECT_KIND.sameAs)
  })
})

// ── resolveHopCap (ratified numbers: D_MAX 16, ceiling 32) ──────────────────────

describe('resolveHopCap', () => {
  it('treats undefined / false / 0 as no-follow (cap 0)', () => {
    expect(resolveHopCap(undefined)).toBe(0)
    expect(resolveHopCap(false)).toBe(0)
    expect(resolveHopCap(0)).toBe(0)
  })
  it('maps true to the ratified default D_MAX = 16', () => {
    expect(resolveHopCap(true)).toBe(16)
    expect(DEFAULT_REDIRECT_HOPS).toBe(16)
  })
  it('passes an explicit positive number, clamped to the hard ceiling 32', () => {
    expect(resolveHopCap(3)).toBe(3)
    expect(resolveHopCap(17)).toBe(17) // between D_MAX and the ceiling is legal policy
    expect(resolveHopCap(999)).toBe(32)
    expect(MAX_REDIRECT_HOPS).toBe(32)
  })
})

// ── Selection: firstInLensRedirect (specs/09 §5/§8) ─────────────────────────────

describe('selectLensRedirect', () => {
  const A = uid(0x1)
  const B = uid(0x2)

  it('reads the selected redirect from a source under the lens', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: REDIRECT_KIND.sameAs }],
    })
    const rec = await selectLensRedirect(ctxWith(chain), A, [ATTESTER])
    expect(rec).toEqual({
      from: A,
      to: B,
      kindCode: 0,
      kind: 'sameAs',
      redirectUID: uid(0xf1),
      attester: ATTESTER,
    })
  })

  it('returns undefined when no lens member asserts one', async () => {
    const chain = makeChain({})
    expect(await selectLensRedirect(ctxWith(chain), A, [ATTESTER])).toBeUndefined()
  })

  it('is first-attester-wins across the lens (§5)', async () => {
    const ALICE = addr(0xa11ce)
    const BOB = addr(0xb0b)
    const chain = makeChain({
      [A]: [
        { attester: BOB, redirectUID: uid(0xb0), target: uid(0x99), kind: 0 },
        { attester: ALICE, redirectUID: uid(0xa0), target: B, kind: 0 },
      ],
    })
    const rec = await selectLensRedirect(ctxWith(chain), A, [ALICE, BOB])
    expect(rec?.attester).toBe(ALICE)
    expect(rec?.to).toBe(B)
  })

  it('ties within one attester break by LOWEST redirect UID, not newest (§5)', async () => {
    const chain = makeChain({
      [A]: [
        // Physically-newest has the HIGHER uid — the old newest-first read
        // would have picked 0xf9; the ratified rule picks 0xf1.
        { attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0 },
        { attester: ATTESTER, redirectUID: uid(0xf9), target: uid(0x99), kind: 0 },
      ],
    })
    const rec = await selectLensRedirect(ctxWith(chain), A, [ATTESTER])
    expect(rec?.redirectUID).toBe(uid(0xf1))
  })

  it('REGRESSION: a revoked newest record neither hides an older active one nor falls through to a lower-priority attester', async () => {
    const ALICE = addr(0xa11ce)
    const BOB = addr(0xb0b)
    const chain = makeChain({
      [A]: [
        // Alice's older redirect is ACTIVE; her newest is REVOKED. The old
        // length=1 newest-first read returned an empty page for Alice and fell
        // through to Bob — a wrong absence AND a first-attester-wins violation.
        { attester: ALICE, redirectUID: uid(0xa1), target: B, kind: 0 },
        { attester: ALICE, redirectUID: uid(0xa9), target: uid(0x98), kind: 0, revoked: true },
        { attester: BOB, redirectUID: uid(0xb0), target: uid(0x99), kind: 0 },
      ],
    })
    const rec = await selectLensRedirect(ctxWith(chain), A, [ALICE, BOB])
    expect(rec?.attester).toBe(ALICE)
    expect(rec?.redirectUID).toBe(uid(0xa1))
  })

  it('excludes revoked redirects entirely (all revoked ⇒ undefined)', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0, revoked: true }],
    })
    expect(await selectLensRedirect(ctxWith(chain), A, [ATTESTER])).toBeUndefined()
  })

  it('paginates past a full page of revoked records (physical-window fidelity)', async () => {
    // 40 physical slots: 39 revoked then 1 active — the active one sits past
    // the first 32-slot page.
    const list: Edge[] = []
    for (let i = 0; i < 39; i++) {
      list.push({
        attester: ATTESTER,
        redirectUID: uid(0xe00 + i),
        target: uid(0x99),
        kind: 0,
        revoked: true,
      })
    }
    list.push({ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0 })
    const chain = makeChain({ [A]: list })
    // 0xe00-range revoked UIDs are LOWER than 0xf1 — but revoked never wins.
    const rec = await selectLensRedirect(ctxWith(chain), A, [ATTESTER])
    expect(rec?.redirectUID).toBe(uid(0xf1))
  })

  it('REGRESSION: a scan past MAX_REDIRECT_SCAN fails CLOSED (throws) — never a silent fall-through to a lower-priority attester', async () => {
    const ALICE = addr(0xa11ce)
    const BOB = addr(0xb0b)
    // Alice spams/rotates 513 physical slots on A: the first 512 revoked, the
    // live one beyond the scan bound. Treating her as redirect-free and serving
    // Bob's record would be the revoked-spam suppression the bound guards
    // against — selection must throw, not guess.
    const list: Edge[] = []
    for (let i = 0; i < 512; i++) {
      list.push({
        attester: ALICE,
        redirectUID: uid(0x10000 + i),
        target: uid(0x99),
        kind: 0,
        revoked: true,
      })
    }
    list.push({ attester: ALICE, redirectUID: uid(0x20000), target: B, kind: 0 })
    list.push({ attester: BOB, redirectUID: uid(0xb0), target: uid(0x98), kind: 0 })
    const chain = makeChain({ [A]: list })
    const err = await selectLensRedirect(ctxWith(chain), A, [ALICE, BOB]).catch((e) => e)
    expect(err).toBeInstanceOf(RedirectScanTruncated)
    expect((err as RedirectScanTruncated).attester).toBe(ALICE)
    // The discovery listing fails closed the same way (canonical/history build on it).
    await expect(listLensRedirects(ctxWith(chain), A, [ALICE, BOB])).rejects.toThrow(
      RedirectScanTruncated,
    )
  })
})

// ── The navigational follower — specs/09 §9 conformance vectors ─────────────────

describe('walkSymlinks — specs/09 §9 vectors', () => {
  const Ax = uid(0xa0)
  const Ay = uid(0xa1)
  const D1 = uid(0xd1)

  it('V1 — simple symlink: Anchor → DATA resolves that DATA (1 hop)', async () => {
    const chain = makeChain({ [Ax]: [sym(ATTESTER, uid(0xf1), D1)] }, { [D1]: dataNode() })
    const out = await walk(chain, Ax)
    expect(out).toMatchObject({ uid: D1, isData: true, status: 'Resolved' })
    expect(out.via).toHaveLength(1)
  })

  it('V2 — symlink to an ANCHOR surfaces it for continued descent', async () => {
    const chain = makeChain({ [Ax]: [sym(ATTESTER, uid(0xf1), Ay)] }, { [Ay]: anchorNode() })
    const out = await walk(chain, Ax)
    expect(out).toMatchObject({ uid: Ay, isData: false, status: 'Resolved' })
  })

  it('V3 — supersededBy is a NON-followed terminal (0 hops, Resolved)', async () => {
    const D2 = uid(0xd2)
    const chain = makeChain(
      {
        [D1]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: D2, kind: 1 }],
        [D2]: [{ attester: ATTESTER, redirectUID: uid(0xf2), target: uid(0xd3), kind: 1 }],
      },
      { [D2]: dataNode() },
    )
    const out = await walkSymlinks(ctxWith(chain), { uid: D1, isData: true }, [ATTESTER], {
      remaining: DEFAULT_REDIRECT_HOPS,
    })
    expect(out).toMatchObject({ uid: D1, isData: true, status: 'Resolved' })
    expect(out.via).toHaveLength(0)
  })

  it('V4 — 17-symlink chain at D_MAX 16 surfaces the node at depth 16 as DepthExceeded', async () => {
    const anchors = Array.from({ length: 18 }, (_, i) => uid(0xa00 + i)) // A0..A17
    const edges: Record<string, Edge[]> = {}
    const nodes: Record<string, Node> = {}
    for (let i = 0; i < 17; i++) {
      edges[anchors[i] as Hex] = [sym(ATTESTER, uid(0xf00 + i), anchors[i + 1] as Hex)]
      nodes[anchors[i + 1] as Hex] = anchorNode()
    }
    const out = await walk(makeChain(edges, nodes), anchors[0] as Hex)
    expect(out.status).toBe('DepthExceeded')
    expect(out.uid).toBe(anchors[16]) // A16, not A17
    expect(out.via).toHaveLength(16)
  })

  it('V5 — direct two-attester symlink cycle stops at the node before the repeat', async () => {
    const alpha = addr(0xa1fa)
    const beta = addr(0xbe7a)
    const A1 = uid(0xa1a)
    const A2 = uid(0xa2a)
    const chain = makeChain(
      {
        [A1]: [sym(alpha, uid(0xf1), A2)],
        [A2]: [sym(beta, uid(0xf2), A1)],
      },
      { [A1]: anchorNode(), [A2]: anchorNode() },
    )
    const out = await walk(chain, A1, [alpha, beta])
    expect(out).toMatchObject({ uid: A2, status: 'CycleStopped' })
    expect(out.via).toHaveLength(1)
  })

  it('V6 — multi-hop cycle A1→A2→A3→A1 stops at A3', async () => {
    const A1 = uid(0xa1a)
    const A2 = uid(0xa2a)
    const A3 = uid(0xa3a)
    const chain = makeChain(
      {
        [A1]: [sym(ATTESTER, uid(0xf1), A2)],
        [A2]: [sym(ATTESTER, uid(0xf2), A3)],
        [A3]: [sym(ATTESTER, uid(0xf3), A1)],
      },
      { [A1]: anchorNode(), [A2]: anchorNode(), [A3]: anchorNode() },
    )
    const out = await walk(chain, A1)
    expect(out).toMatchObject({ uid: A3, status: 'CycleStopped' })
  })

  it('V7 — dangling target (revoked) surfaces the last good node', async () => {
    const A1 = uid(0xa1a)
    const A2 = uid(0xa2a)
    const A3 = uid(0xa3a)
    const chain = makeChain(
      {
        [A1]: [sym(ATTESTER, uid(0xf1), A2)],
        [A2]: [sym(ATTESTER, uid(0xf2), A3)],
      },
      { [A2]: anchorNode(), [A3]: { schema: SCHEMAS.anchor, revoked: true } },
    )
    const out = await walk(chain, A1)
    expect(out).toMatchObject({ uid: A2, status: 'Dangling' })
  })

  it('V7b — dangling read-time TYPING: an unrevoked target that is neither ANCHOR nor DATA', async () => {
    const A1 = uid(0xa1a)
    const P1 = uid(0x9b1)
    const chain = makeChain(
      { [A1]: [sym(ATTESTER, uid(0xf1), P1)] },
      { [P1]: { schema: SCHEMAS.property } }, // exists, unrevoked, wrong type
    )
    const out = await walk(chain, A1)
    expect(out).toMatchObject({ uid: A1, status: 'Dangling' })
  })

  it('V8 — a foreign (cross-lens) symlink is invisible: Resolved, 0 hops', async () => {
    const gamma = addr(0x6a3a)
    const A1 = uid(0xa1a)
    const chain = makeChain(
      { [A1]: [sym(gamma, uid(0xf1), uid(0xa2a))] },
      { [uid(0xa2a)]: anchorNode() },
    )
    const out = await walk(chain, A1, [ATTESTER])
    expect(out).toMatchObject({ uid: A1, status: 'Resolved' })
    expect(out.via).toHaveLength(0)
  })

  it('V9 — supersededBy fork across two lens members: still 0 hops, Resolved', async () => {
    const alpha = addr(0xa1fa)
    const beta = addr(0xbe7a)
    const chain = makeChain({
      [D1]: [
        { attester: alpha, redirectUID: uid(0xf1), target: uid(0xd2), kind: 1 },
        { attester: beta, redirectUID: uid(0xf9), target: uid(0xd9), kind: 1 },
      ],
    })
    const out = await walkSymlinks(ctxWith(chain), { uid: D1, isData: true }, [alpha, beta], {
      remaining: DEFAULT_REDIRECT_HOPS,
    })
    expect(out).toMatchObject({ uid: D1, status: 'Resolved' })
    expect(out.via).toHaveLength(0)
  })

  it('V10 — sameAs is not navigated', async () => {
    const chain = makeChain({
      [D1]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: uid(0xd2), kind: 0 }],
    })
    const out = await walkSymlinks(ctxWith(chain), { uid: D1, isData: true }, [ATTESTER], {
      remaining: DEFAULT_REDIRECT_HOPS,
    })
    expect(out).toMatchObject({ uid: D1, status: 'Resolved' })
  })

  it('V12 — no redirect input yields suppression: kind ≥ 3 is an inert Resolved terminal; the status union has no Suppressed member', async () => {
    const A1 = uid(0xa1a)
    const chain = makeChain({
      [A1]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: uid(0xa2a), kind: 7 }],
    })
    const out = await walk(chain, A1)
    expect(out).toMatchObject({ uid: A1, status: 'Resolved' })
    // Type-level: the follower can never produce a suppression status (§7).
    expectTypeOf<RedirectWalkStatus>().toEqualTypeOf<
      'Resolved' | 'Dangling' | 'CycleStopped' | 'DepthExceeded'
    >()
  })

  it('check ORDER: a dangling edge pending at the depth cap is Dangling, not DepthExceeded (§8)', async () => {
    // A0 →(1 hop)→ A1, whose next edge dangles, with cap 1: the dangling check
    // precedes the depth check.
    const A0 = uid(0xa0a)
    const A1 = uid(0xa1a)
    const chain = makeChain(
      {
        [A0]: [sym(ATTESTER, uid(0xf1), A1)],
        [A1]: [sym(ATTESTER, uid(0xf2), uid(0xdead))],
      },
      { [A1]: anchorNode() }, // 0xdead unknown ⇒ dangling
    )
    const out = await walk(chain, A0, [ATTESTER], 1)
    expect(out).toMatchObject({ uid: A1, status: 'Dangling' })
  })

  it("no-fall-through: a trusted attester's non-navigational winner is terminal even when a lower lens member has a symlink", async () => {
    const ALICE = addr(0xa11ce)
    const BOB = addr(0xb0b)
    const A1 = uid(0xa1a)
    const chain = makeChain(
      {
        [A1]: [
          { attester: ALICE, redirectUID: uid(0xf1), target: uid(0xd9), kind: 3 }, // hint
          sym(BOB, uid(0xf2), uid(0xa2a)),
        ],
      },
      { [uid(0xa2a)]: anchorNode() },
    )
    const out = await walk(chain, A1, [ALICE, BOB])
    // Alice wins selection; her non-symlink stance is NOT overridden by Bob's symlink.
    expect(out).toMatchObject({ uid: A1, status: 'Resolved' })
  })
})

// ── V11: sameAs canonicalization (client/indexer layer, §4.2) ───────────────────

describe('canonicalizeSameAs', () => {
  const A = uid(0x1)
  const B = uid(0x2)
  const C = uid(0x3)

  it('V11 — the canonical representative is the lowest UID in the SCC, entry-independent', async () => {
    // A↔B, B↔C — one SCC {A,B,C}; canonical = A from any entry.
    const edges: Record<string, Edge[]> = {
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0 }],
      [B]: [
        { attester: ATTESTER, redirectUID: uid(0xf2), target: A, kind: 0 },
        { attester: ATTESTER, redirectUID: uid(0xf3), target: C, kind: 0 },
      ],
      [C]: [{ attester: ATTESTER, redirectUID: uid(0xf4), target: B, kind: 0 }],
    }
    for (const entry of [A, B, C]) {
      const out = await canonicalizeSameAs(ctxWith(makeChain(edges)), entry, [ATTESTER])
      expect(out.canonical, `entry ${entry}`).toBe(A)
      expect(out.members).toEqual([A, B, C])
      expect(out.complete).toBe(true)
    }
  })

  it("is lens-scoped: a foreign attester's edge never canonicalizes (§5)", async () => {
    const gamma = addr(0x6a3a)
    const edges: Record<string, Edge[]> = {
      [B]: [
        { attester: gamma, redirectUID: uid(0xf1), target: A, kind: 0 }, // foreign B→A
      ],
    }
    const out = await canonicalizeSameAs(ctxWith(makeChain(edges)), B, [ATTESTER])
    expect(out.canonical).toBe(B) // the foreign edge is invisible
    expect(out.members).toEqual([B])
  })

  it('one-way sameAs (not an SCC): the start is its own component', async () => {
    const edges: Record<string, Edge[]> = {
      [B]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: A, kind: 0 }],
      // A has no edge back — {B} alone is B's SCC.
    }
    const out = await canonicalizeSameAs(ctxWith(makeChain(edges)), B, [ATTESTER])
    expect(out.canonical).toBe(B)
    expect(out.members).toEqual([B])
  })
})

// ── The deliberate supersededBy walk (§2 breadcrumb) ────────────────────────────

describe('walkSupersededBy — maxHops validation (review r3740495862)', () => {
  it('throws InvalidArgument on a non-finite cap; floors a fractional one', async () => {
    const D1 = uid(0xd1)
    const D2 = uid(0xd2)
    const D3 = uid(0xd3)
    const chain = makeChain(
      {
        [D1]: [{ attester: ATTESTER, redirectUID: uid(0xe1), target: D2, kind: 1 }],
        [D2]: [{ attester: ATTESTER, redirectUID: uid(0xe2), target: D3, kind: 1 }],
      },
      { [D2]: { schema: SCHEMAS.data }, [D3]: { schema: SCHEMAS.data } },
    )
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const err = await walkSupersededBy(ctxWith(chain), D1, [ATTESTER], { maxHops: bad }).catch(
        (e) => e,
      )
      expect((err as { code?: string }).code, String(bad)).toBe('InvalidArgument')
    }
    // Fractional floors: 1.5 → exactly ONE hop, never two.
    const out = await walkSupersededBy(ctxWith(chain), D1, [ATTESTER], { maxHops: 1.5 })
    expect(out.chain).toHaveLength(1)
    expect(out.latest).toBe(D2)
  })
})

describe('walkSupersededBy', () => {
  const D1 = uid(0xd1)
  const D2 = uid(0xd2)
  const D3 = uid(0xd3)

  it('walks a healthy chain to the latest version (complete)', async () => {
    const chain = makeChain(
      {
        [D1]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: D2, kind: 1 }],
        [D2]: [{ attester: ATTESTER, redirectUID: uid(0xf2), target: D3, kind: 1 }],
      },
      { [D2]: dataNode(), [D3]: dataNode() },
    )
    const out = await walkSupersededBy(ctxWith(chain), D1, [ATTESTER])
    expect(out.latest).toBe(D3)
    expect(out.chain.map((c) => c.to)).toEqual([D2, D3])
    expect(out.complete).toBe(true)
  })

  it('a broken pointer stops at the last GOOD version (complete: false)', async () => {
    const chain = makeChain(
      {
        [D1]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: D2, kind: 1 }],
        [D2]: [{ attester: ATTESTER, redirectUID: uid(0xf2), target: uid(0xdead), kind: 1 }],
      },
      { [D2]: dataNode() }, // 0xdead unknown ⇒ broken
    )
    const out = await walkSupersededBy(ctxWith(chain), D1, [ATTESTER])
    expect(out.latest).toBe(D2)
    expect(out.complete).toBe(false)
  })

  it('a malformed looping chain stops via the visited-set (complete: false)', async () => {
    const chain = makeChain(
      {
        [D1]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: D2, kind: 1 }],
        [D2]: [{ attester: ATTESTER, redirectUID: uid(0xf2), target: D1, kind: 1 }],
      },
      { [D1]: dataNode(), [D2]: dataNode() },
    )
    const out = await walkSupersededBy(ctxWith(chain), D1, [ATTESTER])
    expect(out.latest).toBe(D2)
    expect(out.complete).toBe(false)
  })
})

// ── efs.redirects.* verbs ───────────────────────────────────────────────────────

/** An EAS `Attested` log (full Log fields so the submitter's `parseEventLogs` can
 * decode it). Mirrors the proven mock in `writes-edge.test.ts`. */
function attestedLog(schema: Hex, mintedUID: Hex, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: attestedEventAbi,
    eventName: 'Attested',
    args: {
      recipient: '0x0000000000000000000000000000000000000000',
      attester: ATTESTER,
      schemaUID: schema,
    },
  })
  const data = encodeAbiParameters([{ name: 'uid', type: 'bytes32' }], [mintedUID])
  return {
    address: EAS,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: 1n,
    blockHash: uid(0xbbbb),
    logIndex,
    transactionHash: uid(0x7777),
    transactionIndex: 0,
    removed: false,
  } as Log
}

/** A mock edge submit context recording each layer's multiAttest requests. */
function makeSubmitCtx(): {
  ctx: EdgeSubmitContext
  calls: { schema: Hex; data: { refUID: Hex; data: Hex; revocable: boolean }[] }[][]
} {
  let globalIndex = 0
  let callIndex = 0
  const receipts = new Map<Hex, TransactionReceipt>()
  const calls: { schema: Hex; data: { refUID: Hex; data: Hex; revocable: boolean }[] }[][] = []
  const walletClient = {
    async writeContract(args: {
      args: readonly [
        readonly { schema: Hex; data: readonly { refUID: Hex; data: Hex; revocable: boolean }[] }[],
      ]
    }) {
      callIndex += 1
      const txHash = uid(callIndex)
      calls.push(args.args[0].map((r) => ({ schema: r.schema, data: [...r.data] })))
      const entries: { schema: Hex }[] = []
      for (const r of args.args[0]) for (const _ of r.data) entries.push({ schema: r.schema })
      const logs = entries.map((e, i) => attestedLog(e.schema, uid(0xd000 + globalIndex + i), i))
      globalIndex += entries.length
      receipts.set(txHash, {
        transactionHash: txHash,
        status: 'success',
        logs,
      } as unknown as TransactionReceipt)
      return txHash
    },
  }
  const publicClient = {
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      const r = receipts.get(hash)
      if (!r) throw new Error(`no receipt for ${hash}`)
      return r
    },
  }
  return {
    calls,
    ctx: {
      walletClient: walletClient as unknown as EdgeSubmitContext['walletClient'],
      publicClient: publicClient as unknown as EdgeSubmitContext['publicClient'],
      easAddress: EAS,
      chainId: 11155111,
      attester: ATTESTER,
      account: ATTESTER,
    },
  }
}

describe('makeRedirectsNs', () => {
  const FROM = uid(0x100)
  const TO = uid(0x200)

  /** Namespace under test with a recording indexer-lifecycle harness. */
  function harness(
    chain: ReadContext['publicClient'],
    ctx = makeSubmitCtx().ctx,
    opts?: { failIndexerCall?: boolean; failIndexerCallWith?: Error; failWaitForReceipt?: Error },
  ) {
    const indexerCalls: { fn: string; uid: Hex }[] = []
    const waited: Hex[] = []
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(chain),
      submitContext: () => ctx,
      revoke: async () => uid(0xfee),
      indexerCall: async (fn, u) => {
        if (opts?.failIndexerCallWith) throw opts.failIndexerCallWith
        if (opts?.failIndexerCall) throw new Error('rpc down')
        indexerCalls.push({ fn, uid: u })
        return uid(0x1dc)
      },
      waitForReceipt: async (tx) => {
        if (opts?.failWaitForReceipt) throw opts.failWaitForReceipt
        waited.push(tx)
      },
    })
    return { ns, indexerCalls, waited }
  }
  const nsWith = (chain: ReadContext['publicClient'], ctx = makeSubmitCtx().ctx) =>
    harness(chain, ctx).ns

  it('set authors a REDIRECT then sends index(uid) — two prompts, index step on the receipt', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const { ns, indexerCalls } = harness(makeChain({}), ctx)
    const receipt = await ns.set(FROM, TO, { kind: 'supersededBy' })
    // 1 multiAttest layer + 1 index tx = 2 signatures, honestly counted.
    expect(receipt.signatureCount).toBe(2)
    const request = calls[0]?.[0]
    expect(request?.schema).toBe(SCHEMAS.redirect)
    const entry = request?.data[0]
    expect(entry?.refUID).toBe(FROM)
    expect(entry?.revocable).toBe(true)
    const [target, k] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint16' }],
      entry?.data as Hex,
    ) as [Hex, number]
    expect(target).toBe(TO)
    expect(Number(k)).toBe(REDIRECT_KIND.supersededBy)
    // The follow-up discovery leg targeted the minted REDIRECT UID.
    const mintedUID = uid(0xd000) // first Attested log in the mock
    expect(indexerCalls).toEqual([{ fn: 'index', uid: mintedUID }])
    expect(receipt.steps.at(-1)).toEqual({ id: 'index', uid: mintedUID, done: true })
  })

  it('set { index: false } opts out: one prompt, no index leg — caller owns eventual indexing', async () => {
    const { ctx } = makeSubmitCtx()
    const { ns, indexerCalls } = harness(makeChain({}), ctx)
    const receipt = await ns.set(FROM, TO, { index: false })
    expect(receipt.signatureCount).toBe(1)
    expect(indexerCalls).toEqual([])
    expect(receipt.steps.find((s) => s.id === 'index')).toBeUndefined()
  })

  it('set throws IndexingIncomplete when the attest landed but the index tx failed — carries the UID + partial receipt', async () => {
    const { ctx } = makeSubmitCtx()
    const { ns } = harness(makeChain({}), ctx, { failIndexerCall: true })
    const err = await ns.set(FROM, TO).catch((e) => e)
    expect(err).toBeInstanceOf(IndexingIncomplete)
    const ii = err as IndexingIncomplete
    expect(ii.op).toBe('index')
    expect(ii.uid).toBe(uid(0xd000)) // the LANDED redirect UID is never lost
    expect(ii.receipt?.status).toBe('partial')
    expect(ii.receipt?.steps.at(-1)).toEqual({ id: 'index', uid: uid(0xd000), done: false })
    expect(ii.code).toBe('PartialBatchFailure')
    // The index leg NEVER broadcast here (plain failure, no IndexUnconfirmed) —
    // no signature was spent on it, so the count stays at the attest layer's 1.
    expect(ii.receipt?.signatureCount).toBe(1)
  })

  it('set preserves the in-flight index tx hash (IndexUnconfirmed → IndexingIncomplete.indexTx)', async () => {
    // r3740769007: when the index tx BROADCAST but its receipt wait failed, the
    // hash must ride the partial-state error — callers reconcile its fate/cost
    // before the idempotent repair. The leg throws IndexUnconfirmed; set()
    // wraps it with the hash preserved.
    const { ctx } = makeSubmitCtx()
    const inflight = new IndexUnconfirmed({
      op: 'index',
      uid: uid(0xd000),
      txHash: uid(0x77),
      cause: new Error('rpc lost mid-wait'),
    })
    const { ns } = harness(makeChain({}), ctx, { failIndexerCallWith: inflight })
    const err = await ns.set(FROM, TO).catch((e) => e)
    expect(err).toBeInstanceOf(IndexingIncomplete)
    const ii = err as IndexingIncomplete
    expect(ii.uid).toBe(uid(0xd000))
    expect(ii.indexTx).toBe(uid(0x77)) // the in-flight indexer tx, never discarded
    expect(ii.receipt?.status).toBe('partial')
    // The user SIGNED AND SENT the index tx — the recovery artifact counts it
    // (r3740796049): 1 attest layer + 1 broadcast index tx.
    expect(ii.receipt?.signatureCount).toBe(2)
  })

  it('a LOST-RESPONSE index send is flagged UNKNOWN — never "never broadcast" (r3741441637)', async () => {
    // The wallet prompted and signed; the transport dropped before the hash
    // returned. The partial state must say UNKNOWN (may still mine, no hash)
    // and count the signed prompt.
    const { ctx } = makeSubmitCtx()
    const lost = new IndexSendUnknown({
      op: 'index',
      uid: uid(0xd000),
      cause: new Error('fetch failed: socket hang up'),
    })
    const { ns } = harness(makeChain({}), ctx, { failIndexerCallWith: lost })
    const err = await ns.set(FROM, TO).catch((e) => e)
    expect(err).toBeInstanceOf(IndexingIncomplete)
    const ii = err as IndexingIncomplete
    expect(ii.indexBroadcastUnknown).toBe(true)
    expect(ii.indexTx).toBeUndefined() // no hash exists to carry
    expect(String(ii.message)).toMatch(/UNKNOWN and it may still mine/)
    expect(ii.receipt?.signatureCount).toBe(2) // the signed prompt counts
  })

  it('remove flags a LOST-RESPONSE indexRevocation send UNKNOWN too (r3741506930)', async () => {
    const lost = new IndexSendUnknown({
      op: 'indexRevocation',
      uid: uid(0xabc),
      cause: new Error('fetch failed: socket hang up'),
    })
    const { ns } = harness(makeChain({}), makeSubmitCtx().ctx, { failIndexerCallWith: lost })
    const err = await ns.remove(uid(0xabc)).catch((e) => e)
    expect(err).toBeInstanceOf(IndexingIncomplete)
    const ii = err as IndexingIncomplete
    expect(ii.txHash).toBe(uid(0xfee)) // the landed revoke leg
    expect(ii.indexTx).toBeUndefined() // no hash exists for the lost send
    expect(ii.indexBroadcastUnknown).toBe(true)
    expect(String(ii.message)).toMatch(/UNKNOWN and it may still mine/)
  })

  it('remove preserves the in-flight indexRevocation tx hash alongside the revoke tx', async () => {
    const inflight = new IndexUnconfirmed({
      op: 'indexRevocation',
      uid: uid(0xabc),
      txHash: uid(0x78),
      cause: new Error('rpc lost mid-wait'),
    })
    const { ns } = harness(makeChain({}), makeSubmitCtx().ctx, { failIndexerCallWith: inflight })
    const err = await ns.remove(uid(0xabc)).catch((e) => e)
    expect(err).toBeInstanceOf(IndexingIncomplete)
    const ii = err as IndexingIncomplete
    expect(ii.txHash).toBe(uid(0xfee)) // the landed revoke leg
    expect(ii.indexTx).toBe(uid(0x78)) // the in-flight indexer leg
  })

  it('set defaults kind to sameAs', async () => {
    const { ctx, calls } = makeSubmitCtx()
    await nsWith(makeChain({}), ctx).set(FROM, TO)
    const [, k] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint16' }],
      calls[0]?.[0]?.data[0]?.data as Hex,
    ) as [Hex, number]
    expect(Number(k)).toBe(REDIRECT_KIND.sameAs)
  })

  it('set rejects an unrecognized kind name (InvalidArgument)', async () => {
    await expect(
      nsWith(makeChain({})).set(FROM, TO, { kind: 'bogus' as never }),
    ).rejects.toMatchObject({ code: 'InvalidArgument' })
  })

  it('remove revokes, WAITS for the revoke to mine, then sends indexRevocation', async () => {
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const indexerCalls: { fn: string; uid: Hex }[] = []
    const waited: Hex[] = []
    const order: string[] = []
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(makeChain({})),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async (schema, u) => {
        order.push('revoke')
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
      indexerCall: async (fn, u) => {
        order.push(fn)
        indexerCalls.push({ fn, uid: u })
        return uid(0x1dc)
      },
      waitForReceipt: async (tx) => {
        order.push('wait')
        waited.push(tx)
      },
    })
    const receipt = await ns.remove(uid(0xabc))
    expect(revokeCall).toEqual({ schema: SCHEMAS.redirect, uid: uid(0xabc) })
    expect(receipt).toEqual({ revokeTx: uid(0xfee), indexRevocationTx: uid(0x1dc) })
    // The contract requires the revoke to be MINED before indexRevocation.
    expect(order).toEqual(['revoke', 'wait', 'indexRevocation'])
    expect(waited).toEqual([uid(0xfee)])
    expect(indexerCalls).toEqual([{ fn: 'indexRevocation', uid: uid(0xabc) }])
  })

  it('remove { index: false } returns only the revoke tx', async () => {
    const { ns, indexerCalls } = harness(makeChain({}))
    const receipt = await ns.remove(uid(0xabc), { index: false })
    expect(receipt).toEqual({ revokeTx: uid(0xfee) })
    expect(indexerCalls).toEqual([])
  })

  it('remove throws IndexingIncomplete when the revoke landed but the mirror tx failed', async () => {
    const { ns } = harness(makeChain({}), makeSubmitCtx().ctx, { failIndexerCall: true })
    const err = await ns.remove(uid(0xabc)).catch((e) => e)
    expect(err).toBeInstanceOf(IndexingIncomplete)
    const ii = err as IndexingIncomplete
    expect(ii.op).toBe('indexRevocation')
    expect(ii.uid).toBe(uid(0xabc))
    expect(ii.txHash).toBe(uid(0xfee)) // the landed revoke leg
  })

  it('REGRESSION: a failed/REVERTED revoke wait escapes RAW — never rebranded IndexingIncomplete', async () => {
    // A mined-but-reverted revoke means the redirect is still fully active in
    // EAS: IndexingIncomplete's "the revoke landed — efs.index(uid) repairs it"
    // guidance would be false on every clause, and the repair would then report
    // 'already-indexed' (closing the loop on the lie). The revoke leg's failure
    // must surface as itself.
    const reverted = Object.assign(new Error('transaction reverted on-chain (tx 0xfee).'), {
      code: 'ContractReverted',
    })
    const { ns, indexerCalls } = harness(makeChain({}), makeSubmitCtx().ctx, {
      failWaitForReceipt: reverted,
    })
    const err = await ns.remove(uid(0xabc)).catch((e) => e)
    expect(err).toBe(reverted) // the RAW failure, not IndexingIncomplete
    expect(err).not.toBeInstanceOf(IndexingIncomplete)
    expect(indexerCalls).toHaveLength(0) // indexRevocation never attempted
  })

  it('re-selects WITHIN the winning attester after a raced revoke — never falls through (r3740967874)', async () => {
    // Attester A's lowest-UID redirect is revoked between the scan and the EAS
    // decode, but A still asserts a second active redirect. First-attester-wins:
    // the selection must return A's surviving record, never fall through to the
    // lower-priority attester B.
    const B = addr(0xacc02)
    const chain = makeChain({
      [FROM]: [
        {
          attester: ATTESTER,
          redirectUID: uid(0xf1), // lowest — raced away
          target: TO,
          kind: REDIRECT_KIND.sameAs,
          revokedAfterScan: true,
        },
        {
          attester: ATTESTER,
          redirectUID: uid(0xf2), // A's surviving record — the honest winner
          target: uid(0x222),
          kind: REDIRECT_KIND.sameAs,
        },
        {
          attester: B,
          redirectUID: uid(0xf3),
          target: uid(0x333),
          kind: REDIRECT_KIND.sameAs,
        },
      ],
    })
    const rec = await nsWith(chain).get(FROM, { lens: lens([ATTESTER, B]) })
    expect(rec?.attester).toBe(ATTESTER) // not B — no fall-through
    expect(rec?.redirectUID).toBe(uid(0xf2))
    expect(rec?.to).toBe(uid(0x222))
  })

  it('a redirect revoked BETWEEN the scan and the EAS decode is discarded (r3740949738)', async () => {
    // The indexer scan is active-only, but the follow-up getAttestation is a
    // second read — a revoke landing in that window used to be honored for one
    // more read. The decode now rechecks revocationTime on the authoritative
    // record and reports absence.
    const chain = makeChain({
      [FROM]: [
        {
          attester: ATTESTER,
          redirectUID: uid(0xf1),
          target: TO,
          kind: REDIRECT_KIND.sameAs,
          revokedAfterScan: true,
        },
      ],
    })
    expect(await nsWith(chain).get(FROM)).toBeUndefined()
    expect(await nsWith(chain).list(FROM)).toEqual([])
  })

  it('get returns the SELECTED record (any kind, ratified selection) under the default lens', async () => {
    const chain = makeChain({
      [FROM]: [
        {
          attester: ATTESTER,
          redirectUID: uid(0xf1),
          target: TO,
          kind: REDIRECT_KIND.relatedVersion,
        },
      ],
    })
    const rec = await nsWith(chain).get(FROM)
    expect(rec?.to).toBe(TO)
    expect(rec?.kind).toBe('relatedVersion') // surfaces the literal record, any kind
  })

  it('get scopes to the explicit lens', async () => {
    const ALICE = addr(0xa11ce)
    const chain = makeChain({
      [FROM]: [{ attester: ALICE, redirectUID: uid(0xa0), target: TO, kind: 0 }],
    })
    const ns = nsWith(chain)
    expect(await ns.get(FROM)).toBeUndefined()
    expect((await ns.get(FROM, { lens: ALICE }))?.attester).toBe(ALICE)
  })

  it('list surfaces EVERY active lens-visible redirect (ascending UID; revoked excluded)', async () => {
    const ALICE = addr(0xa11ce)
    const chain = makeChain({
      [FROM]: [
        { attester: ATTESTER, redirectUID: uid(0xf9), target: uid(0x99), kind: 3 },
        { attester: ATTESTER, redirectUID: uid(0xf1), target: TO, kind: 0 },
        { attester: ATTESTER, redirectUID: uid(0xf5), target: uid(0x98), kind: 0, revoked: true },
        { attester: ALICE, redirectUID: uid(0xa0), target: uid(0x97), kind: 2 },
      ],
    })
    const out = await nsWith(chain).list(FROM, { lens: ATTESTER })
    expect(out.map((r) => r.redirectUID)).toEqual([uid(0xf1), uid(0xf9)]) // active only, sorted
  })

  it('canonical + history delegate to the ratified engines', async () => {
    const A = uid(0x1)
    const B = uid(0x2)
    const chain = makeChain(
      {
        [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0 }],
        [B]: [
          { attester: ATTESTER, redirectUID: uid(0xf2), target: A, kind: 0 },
          { attester: ATTESTER, redirectUID: uid(0xf3), target: uid(0x3), kind: 1 },
        ],
      },
      { [uid(0x3)]: dataNode() },
    )
    const ns = nsWith(chain)
    expect((await ns.canonical(B)).canonical).toBe(A)
    const history = await ns.history(B)
    expect(history.latest).toBe(uid(0x3))
    expect(history.complete).toBe(true)
  })
})

describe('resolveHopCap input validation (review r3740482352)', () => {
  it('throws InvalidArgument on non-finite caps instead of silently disabling following', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const err = (() => {
        try {
          resolveHopCap(bad)
          return undefined
        } catch (e) {
          return e as { code?: string }
        }
      })()
      expect(err?.code, String(bad)).toBe('InvalidArgument')
    }
  })
})

describe('RevokeUnconfirmed (review r3740688515)', () => {
  const nsWithWait = (failure: Error) =>
    makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(makeChain({})),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async () => uid(0xfee),
      indexerCall: async () => uid(0x1dc),
      waitForReceipt: async () => {
        throw failure
      },
    })

  it('an UNKNOWN revoke-wait failure carries the hash; a CONFIRMED revert stays raw', async () => {
    // Unknown outcome (RPC loss): structured, with the in-flight revokeTx.
    const rpcLoss = Object.assign(new Error('RPC gone'), { code: 'RpcError' })
    const err = await nsWithWait(rpcLoss)
      .remove(uid(0xabc))
      .catch((e) => e)
    expect(err).toBeInstanceOf(RevokeUnconfirmed)
    expect((err as RevokeUnconfirmed).revokeTx).toBe(uid(0xfee))
    expect((err as RevokeUnconfirmed).cause).toBe(rpcLoss)
    // Confirmed reverted: definite failure — propagates raw (redirect still active).
    const reverted = Object.assign(new Error('reverted'), { code: 'ContractReverted' })
    const err2 = await nsWithWait(reverted)
      .remove(uid(0xabc))
      .catch((e) => e)
    expect(err2).toBe(reverted)
    expect(err2).not.toBeInstanceOf(RevokeUnconfirmed)
  })
})
