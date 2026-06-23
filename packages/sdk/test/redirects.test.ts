/**
 * REDIRECT (alias) primitive — ADR-0050. Covers the pure plan builder, the
 * `efs.redirects.*` write/read verbs (over mock clients), and the read-time
 * resolution engine: single + multi-hop following, the opt-out default, cycle
 * detection, the hop cap, never-auto-followed kinds, and lens scoping. No live chain.
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
import { describe, expect, it } from 'vitest'
import type { EfsDeployment, EfsSchemaUIDs } from '../src/chain/deployments.js'
import { attestedEventAbi } from '../src/eas/abi.js'
import { SchemaEncoder } from '../src/eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../src/eas/schemas.js'
import { RedirectCycle, RedirectHopLimit } from '../src/errors.js'
import type { ReadContext } from '../src/reads/context.js'
import {
  DEFAULT_REDIRECT_HOPS,
  MAX_REDIRECT_HOPS,
  followRedirectChain,
  readActiveRedirect,
  resolveHopCap,
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

// ── A mock chain modeling the lens-scoped referencing index + EAS getAttestation ──
//
// `edges`: source UID → list of { attester, redirectUID, target, kind, revoked }.
// Mirrors getReferencingBySchemaAndAttester(source, REDIRECT, attester, …, reverse,
// showRevoked=false) returning that attester's most-recent active redirect, and
// getAttestation(redirectUID) returning its encoded data.

type Edge = { attester: Address; redirectUID: Hex; target: Hex; kind: number; revoked?: boolean }

function makeChain(edges: Record<string, Edge[]>): ReadContext['publicClient'] {
  // Index each redirectUID → its decoded payload for getAttestation.
  const byUID = new Map<Hex, { target: Hex; kind: number }>()
  for (const list of Object.values(edges)) {
    for (const e of list) byUID.set(e.redirectUID, { target: e.target, kind: e.kind })
  }
  return {
    async readContract(a: { functionName: string; args?: readonly unknown[] }) {
      const args = a.args ?? []
      if (a.functionName === 'getReferencingBySchemaAndAttester') {
        const [source, , attester] = args as [Hex, Hex, Address]
        const list = (edges[source] ?? []).filter((e) => e.attester === attester && !e.revoked)
        // reverseOrder=true → most recent first; the namespace asks for length 1.
        const top = list[list.length - 1]
        return top ? [top.redirectUID] : []
      }
      if (a.functionName === 'getAttestation') {
        const [u] = args as [Hex]
        const rec = byUID.get(u)
        if (!rec) return { data: '0x' as Hex }
        return { data: redirectData(rec.target, rec.kind) }
      }
      return uid(0)
    },
  } as unknown as ReadContext['publicClient']
}

function ctxWith(client: ReadContext['publicClient']): ReadContext {
  return { publicClient: client, deployment, account: ATTESTER }
}

// ── Pure builder ────────────────────────────────────────────────────────────────

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
    // data = (target, kind)
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

// ── resolveHopCap (option normalization) ──────────────────────────────────────────

describe('resolveHopCap', () => {
  it('treats undefined / false / 0 as no-follow (cap 0)', () => {
    expect(resolveHopCap(undefined)).toBe(0)
    expect(resolveHopCap(false)).toBe(0)
    expect(resolveHopCap(0)).toBe(0)
  })
  it('maps true to the default cap', () => {
    expect(resolveHopCap(true)).toBe(DEFAULT_REDIRECT_HOPS)
  })
  it('passes an explicit positive number, clamped to the hard ceiling', () => {
    expect(resolveHopCap(3)).toBe(3)
    expect(resolveHopCap(999)).toBe(MAX_REDIRECT_HOPS)
  })
})

// ── readActiveRedirect (lens-scoped, single record) ───────────────────────────────

describe('readActiveRedirect', () => {
  const A = uid(0x1)
  const B = uid(0x2)

  it('reads the active redirect from a source under the lens', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: REDIRECT_KIND.sameAs }],
    })
    const rec = await readActiveRedirect(ctxWith(chain), A, [ATTESTER])
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
    expect(await readActiveRedirect(ctxWith(chain), A, [ATTESTER])).toBeUndefined()
  })

  it('is first-attester-wins across the lens (ADR-0031)', async () => {
    const ALICE = addr(0xa11ce)
    const BOB = addr(0xb0b)
    const chain = makeChain({
      [A]: [
        { attester: BOB, redirectUID: uid(0xb0), target: uid(0x99), kind: 0 },
        { attester: ALICE, redirectUID: uid(0xa0), target: B, kind: 0 },
      ],
    })
    // Lens order [ALICE, BOB] → Alice's redirect wins.
    const rec = await readActiveRedirect(ctxWith(chain), A, [ALICE, BOB])
    expect(rec?.attester).toBe(ALICE)
    expect(rec?.to).toBe(B)
  })

  it('excludes revoked redirects (showRevoked=false)', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0, revoked: true }],
    })
    expect(await readActiveRedirect(ctxWith(chain), A, [ATTESTER])).toBeUndefined()
  })

  it('with requireFollowable, a discovery-hint kind (relatedVersion) does NOT resolve', async () => {
    const chain = makeChain({
      [A]: [
        {
          attester: ATTESTER,
          redirectUID: uid(0xf1),
          target: B,
          kind: REDIRECT_KIND.relatedVersion,
        },
      ],
    })
    expect(
      await readActiveRedirect(ctxWith(chain), A, [ATTESTER], { requireFollowable: true }),
    ).toBeUndefined()
    // But the literal read (get path) DOES surface it.
    const lit = await readActiveRedirect(ctxWith(chain), A, [ATTESTER])
    expect(lit?.kind).toBe('relatedVersion')
  })
})

// ── followRedirectChain (multi-hop, opt-out, cycle, cap) ──────────────────────────

describe('followRedirectChain', () => {
  const A = uid(0x1)
  const B = uid(0x2)
  const C = uid(0x3)

  it('cap 0 short-circuits to the start with an empty chain (opt-out)', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0 }],
    })
    const out = await followRedirectChain(ctxWith(chain), A, [ATTESTER], 0)
    expect(out).toEqual({ target: A, via: [] })
  })

  it('follows a single hop to the canonical', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: REDIRECT_KIND.sameAs }],
    })
    const out = await followRedirectChain(ctxWith(chain), A, [ATTESTER], DEFAULT_REDIRECT_HOPS)
    expect(out.target).toBe(B)
    expect(out.via).toHaveLength(1)
    expect(out.via[0]?.from).toBe(A)
    expect(out.via[0]?.to).toBe(B)
  })

  it('follows a multi-hop chain A→B→C to the terminal', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 1 }],
      [B]: [{ attester: ATTESTER, redirectUID: uid(0xf2), target: C, kind: 1 }],
    })
    const out = await followRedirectChain(ctxWith(chain), A, [ATTESTER], DEFAULT_REDIRECT_HOPS)
    expect(out.target).toBe(C)
    expect(out.via.map((v) => v.to)).toEqual([B, C])
  })

  it('stops at a hint kind mid-chain (relatedVersion is not auto-followed)', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: REDIRECT_KIND.sameAs }],
      [B]: [
        {
          attester: ATTESTER,
          redirectUID: uid(0xf2),
          target: C,
          kind: REDIRECT_KIND.relatedVersion,
        },
      ],
    })
    const out = await followRedirectChain(ctxWith(chain), A, [ATTESTER], DEFAULT_REDIRECT_HOPS)
    // Followed A→B (sameAs), then stopped — B's outgoing edge is a hint.
    expect(out.target).toBe(B)
    expect(out.via.map((v) => v.to)).toEqual([B])
  })

  it('throws RedirectCycle on a multi-hop cycle (fail-closed; no SCC guess)', async () => {
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0 }],
      [B]: [{ attester: ATTESTER, redirectUID: uid(0xf2), target: A, kind: 0 }],
    })
    await expect(
      followRedirectChain(ctxWith(chain), A, [ATTESTER], DEFAULT_REDIRECT_HOPS),
    ).rejects.toBeInstanceOf(RedirectCycle)
  })

  it('accepts a chain whose length EQUALS the cap and then terminates (no false hop-limit)', async () => {
    // A→B with cap 1, and B has no onward redirect → a valid 1-hop chain. The cap counts
    // FOLLOWED hops; consuming the last allowed hop and landing on a terminal is fine (the old
    // code threw RedirectHopLimit here without checking whether B had a further redirect).
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: REDIRECT_KIND.sameAs }],
      // B: no active redirect (terminal)
    })
    const out = await followRedirectChain(ctxWith(chain), A, [ATTESTER], 1)
    expect(out.target).toBe(B)
    expect(out.via).toHaveLength(1)
    expect(out.via[0]?.to).toBe(B)
  })

  it('throws RedirectHopLimit when the chain does not terminate within the cap', async () => {
    // A→B→C→… with C also redirecting onward past a tiny cap of 2.
    const D = uid(0x4)
    const chain = makeChain({
      [A]: [{ attester: ATTESTER, redirectUID: uid(0xf1), target: B, kind: 0 }],
      [B]: [{ attester: ATTESTER, redirectUID: uid(0xf2), target: C, kind: 0 }],
      [C]: [{ attester: ATTESTER, redirectUID: uid(0xf3), target: D, kind: 0 }],
    })
    await expect(followRedirectChain(ctxWith(chain), A, [ATTESTER], 2)).rejects.toBeInstanceOf(
      RedirectHopLimit,
    )
  })
})

// ── efs.redirects.* write/read verbs ──────────────────────────────────────────────

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

  it('set authors a REDIRECT (refUID = from, data = (to, kind)) — one signature', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(makeChain({})),
      submitContext: () => ctx,
      revoke: async () => uid(0xfee),
    })
    const receipt = await ns.set(FROM, TO, { kind: 'supersededBy' })
    expect(receipt.signatureCount).toBe(1)
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
  })

  it('set defaults kind to sameAs', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(makeChain({})),
      submitContext: () => ctx,
      revoke: async () => uid(0xfee),
    })
    await ns.set(FROM, TO)
    const [, k] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint16' }],
      calls[0]?.[0]?.data[0]?.data as Hex,
    ) as [Hex, number]
    expect(Number(k)).toBe(REDIRECT_KIND.sameAs)
  })

  it('set rejects an unrecognized kind name (InvalidArgument)', async () => {
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(makeChain({})),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async () => uid(0xfee),
    })
    await expect(ns.set(FROM, TO, { kind: 'bogus' as never })).rejects.toMatchObject({
      code: 'InvalidArgument',
    })
  })

  it('remove revokes the right UID under the REDIRECT schema', async () => {
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(makeChain({})),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async (schema, u) => {
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
    })
    const tx = await ns.remove(uid(0xabc))
    expect(tx).toBe(uid(0xfee))
    expect(revokeCall).toEqual({ schema: SCHEMAS.redirect, uid: uid(0xabc) })
  })

  it('get reads the active record (literal, any kind) under the default lens', async () => {
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
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(chain),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async () => uid(0xfee),
    })
    const rec = await ns.get(FROM)
    // The literal get surfaces the hint kind (not chain-followed, not kind-filtered).
    expect(rec?.to).toBe(TO)
    expect(rec?.kind).toBe('relatedVersion')
  })

  it('get scopes to the explicit lens', async () => {
    const ALICE = addr(0xa11ce)
    const chain = makeChain({
      [FROM]: [{ attester: ALICE, redirectUID: uid(0xa0), target: TO, kind: 0 }],
    })
    const ns = makeRedirectsNs({
      getDeployment: () => deployment,
      readContext: () => ctxWith(chain),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async () => uid(0xfee),
    })
    // Default account lens (ATTESTER) finds nothing; an explicit [ALICE] lens does.
    expect(await ns.get(FROM)).toBeUndefined()
    expect((await ns.get(FROM, { lens: ALICE }))?.attester).toBe(ALICE)
  })
})
