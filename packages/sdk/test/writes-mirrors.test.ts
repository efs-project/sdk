/**
 * Standalone MIRROR write primitive — the pure plan builder (`buildMirrorPlan`),
 * the transport-anchor resolver (`resolveMirrorTransport`), and the namespace verbs
 * (`makeMirrorsNs`) over mock clients. No live chain.
 *
 * Verifies: `add` with an explicit transport, `add` with a scheme-derived transport
 * (deployment map + /transports/<scheme> path fallback), the transport-not-found
 * error, `remove` revoking the right UID under the MIRROR schema, and the lens-scoped
 * `list`.
 */

import {
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem'
import { describe, expect, it } from 'vitest'
import type { EfsDeployment, EfsSchemaUIDs } from '../src/chain/deployments.js'
import { attestedEventAbi } from '../src/eas/abi.js'
import { SchemaEncoder } from '../src/eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../src/eas/schemas.js'
import type { EdgeSubmitContext } from '../src/writes/edge-submit.js'
import { EDGE_REF, buildMirrorPlan } from '../src/writes/edge.js'
import { makeMirrorsNs, resolveMirrorTransport } from '../src/writes/mirrors.js'

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
const FILE_VIEW = addr(0x202)
const ATTESTER = addr(0xacc01)

const IPFS_TRANSPORT = uid(0x7191)
const WEB3_TRANSPORT = uid(0x7193)
const ARWEAVE_TRANSPORT = uid(0x7195)

const deployment: EfsDeployment = {
  chainId: 11155111,
  schemas: SCHEMAS,
  contracts: {
    eas: EAS,
    schemaRegistry: addr(0x5c),
    indexer: INDEXER,
    router: addr(0x201),
    fileView: FILE_VIEW,
    edgeResolver: addr(0xed6e),
    mirrorResolver: addr(0x203),
    listResolver: addr(0x204),
    listEntryResolver: addr(0x205),
    listReader: addr(0x206),
    aliasResolver: addr(0x207),
    systemAccount: addr(0x208),
  },
  transports: { ipfs: IPFS_TRANSPORT, web3: WEB3_TRANSPORT, arweave: ARWEAVE_TRANSPORT },
}

const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)

// ── Pure builder ─────────────────────────────────────────────────────────────────

describe('buildMirrorPlan', () => {
  const DATA = uid(0x900)

  it('emits one MIRROR (refUID = DATA, data = (transport, uri)) — single-layer', () => {
    const plan = buildMirrorPlan(SCHEMAS, DATA, IPFS_TRANSPORT, 'ipfs://Qm123')
    expect(plan.attestations).toHaveLength(1)
    const m = plan.attestations[0]
    expect(m?.kind).toBe('MIRROR')
    expect(m?.ref).toBe(EDGE_REF.MIRROR)
    expect(m?.layer).toBe(1)
    expect(m?.schema).toBe(SCHEMAS.mirror)
    expect(m?.revocable).toBe(true) // MirrorResolver requires revocable
    expect(m?.refUID).toBe(DATA) // DATA rides in refUID (concrete)
    expect(m?.dataRefs).toEqual([]) // no fresh siblings
    // data = (transportDefinition, uri) — the exact encoder shape graph.ts emits
    expect(m?.data).toBe(mirrorEnc.encodeData([IPFS_TRANSPORT, 'ipfs://Qm123']))
  })
})

// ── Mock chain for the submit path ───────────────────────────────────────────────

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

function makeSubmitCtx(): {
  ctx: EdgeSubmitContext
  calls: { schema: Hex; data: { refUID: Hex; data: Hex; revocable: boolean }[] }[][]
} {
  let globalIndex = 0
  let callIndex = 0
  const receipts = new Map<Hex, TransactionReceipt>()
  const calls: {
    schema: Hex
    data: { refUID: Hex; data: Hex; revocable: boolean }[]
  }[][] = []
  const walletClient = {
    async writeContract(args: {
      args: readonly [
        readonly { schema: Hex; data: readonly { refUID: Hex; data: Hex; revocable: boolean }[] }[],
      ]
    }) {
      callIndex += 1
      const txHash = uid(callIndex)
      const layer = args.args[0].map((r) => ({ schema: r.schema, data: [...r.data] }))
      calls.push(layer)
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

function makeReadClient(handler: (fn: string, args: readonly unknown[]) => unknown): {
  readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown>
} {
  return {
    async readContract(a: { functionName: string; args?: readonly unknown[] }) {
      return handler(a.functionName, a.args ?? [])
    },
  }
}

// ── resolveMirrorTransport ─────────────────────────────────────────────────────────

describe('resolveMirrorTransport', () => {
  it('rejects an empty/blank URI with InvalidArgument even with an explicit transport', async () => {
    // An explicit transport must NOT smuggle an empty URI into the MIRROR plan — that would
    // make the caller sign a tx MirrorResolver can only revert. Same preflight as fs.write.
    const err = await resolveMirrorTransport(
      makeReadClient(() => {
        throw new Error('should not read — rejected before any resolution')
      }) as never,
      deployment,
      '',
      uid(0xe5b1), // explicit transport present
    ).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
  })

  it('rejects a URI over the 8192-byte MirrorResolver limit (even with an explicit transport)', async () => {
    const huge = `ipfs://${'a'.repeat(8200)}` // > 8192 UTF-8 bytes
    const err = await resolveMirrorTransport(
      makeReadClient(() => {
        throw new Error('should not read — rejected before any resolution')
      }) as never,
      deployment,
      huge,
      uid(0xe5b1), // explicit transport present
    ).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/8192-byte limit/)
  })

  it('an explicit transport UID wins (scheme not consulted)', async () => {
    const out = await resolveMirrorTransport(
      makeReadClient(() => {
        throw new Error('should not read when transport is explicit')
      }) as never,
      deployment,
      'whatever://x',
      uid(0xe5b1),
    )
    expect(out).toBe(uid(0xe5b1))
  })

  it('derives from the deployment transports map by scheme (ipfs)', async () => {
    const out = await resolveMirrorTransport(
      makeReadClient(() => {
        throw new Error('should not read when the map has the scheme')
      }) as never,
      deployment,
      'ipfs://Qm123',
      undefined,
    )
    expect(out).toBe(IPFS_TRANSPORT)
  })

  it("normalizes ar:// to the 'arweave' transport key", async () => {
    const out = await resolveMirrorTransport(
      makeReadClient(() => {
        throw new Error('should not read when the map has arweave')
      }) as never,
      deployment,
      'ar://abc',
      undefined,
    )
    expect(out).toBe(ARWEAVE_TRANSPORT)
  })

  it('falls back to resolving /transports/<scheme> on-chain when the map lacks it', async () => {
    const HTTPS_ANCHOR = uid(0x7199)
    const segments: string[] = []
    const out = await resolveMirrorTransport(
      makeReadClient((fn, args) => {
        if (fn === 'rootAnchorUID') return uid(0x1)
        if (fn === 'resolvePath') {
          segments.push(args[1] as string)
          return HTTPS_ANCHOR // both /transports and https resolve
        }
        return uid(0)
      }) as never,
      deployment, // no `https` key in the map
      'https://example.com/x',
      undefined,
    )
    expect(out).toBe(HTTPS_ANCHOR)
    expect(segments).toEqual(['transports', 'https'])
  })

  it('throws MissingTransport when neither the map nor the on-chain anchor resolves', async () => {
    await expect(
      resolveMirrorTransport(
        makeReadClient((fn) => {
          if (fn === 'rootAnchorUID') return uid(0x1)
          if (fn === 'resolvePath') return uid(0) // ZERO → ParentNotFound in the walk
          return uid(0)
        }) as never,
        deployment,
        'ftp://nowhere',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'MissingTransport' })
  })

  it('throws MissingTransport for a URI with no scheme prefix', async () => {
    await expect(
      resolveMirrorTransport(
        makeReadClient(() => uid(0)) as never,
        deployment,
        'no-scheme-here',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'MissingTransport' })
  })
})

// ── mirrors namespace ──────────────────────────────────────────────────────────────

describe('makeMirrorsNs', () => {
  const DATA = uid(0x900)

  it('add (explicit transport) emits the MIRROR and submits (one signature)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const mirrors = makeMirrorsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => {
        throw new Error('explicit transport should not read')
      }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0xfee),
    })
    const receipt = await mirrors.add(DATA, { uri: 'ipfs://Qm999', transport: uid(0xe5b1) })
    expect(receipt.signatureCount).toBe(1) // single layer → one popup
    expect(receipt.steps).toHaveLength(1)
    expect(calls).toHaveLength(1)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.refUID).toBe(DATA)
    expect(entry?.revocable).toBe(true)
    expect(entry?.data).toBe(mirrorEnc.encodeData([uid(0xe5b1), 'ipfs://Qm999']))
  })

  it('add (scheme-derived transport) resolves the anchor from the deployment map', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const mirrors = makeMirrorsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => {
        throw new Error('map hit should not read')
      }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0xfee),
    })
    await mirrors.add(DATA, { uri: 'ipfs://QmAAA' })
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.data).toBe(mirrorEnc.encodeData([IPFS_TRANSPORT, 'ipfs://QmAAA']))
  })

  it('add throws MissingTransport when the scheme cannot be resolved (no chain revert)', async () => {
    const { ctx } = makeSubmitCtx()
    const mirrors = makeMirrorsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn) => {
        if (fn === 'rootAnchorUID') return uid(0x1)
        if (fn === 'resolvePath') return uid(0)
        return uid(0)
      }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0xfee),
    })
    await expect(mirrors.add(DATA, { uri: 'ftp://nope' })).rejects.toMatchObject({
      code: 'MissingTransport',
    })
  })

  it('add guards the live chain BEFORE the transport-resolution read (WrongChain, no read, no submit)', async () => {
    // The on-chain transport fallback (resolveMirrorTransport → /transports/<scheme>) FEEDS
    // the plan, so a drifted public client could resolve it on the wrong chain. The guard must
    // run BEFORE that read — a scheme NOT in the deployment map forces the on-chain fallback;
    // assert the read never fires and nothing submits.
    const { ctx, calls } = makeSubmitCtx()
    let readCalled = false
    const mirrors = makeMirrorsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => {
        readCalled = true
        return uid(0)
      }) as never,
      submitContext: () => ({
        ...ctx,
        assertChain: async () => {
          throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
        },
      }),
      attester: () => ATTESTER,
      revoke: async () => uid(0xfee),
    })
    const err = await mirrors.add(DATA, { uri: 'https://example.com/x' }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
    expect(readCalled).toBe(false) // transport-resolution read never ran
    expect(calls).toHaveLength(0) // nothing submitted
  })

  it('remove revokes the right UID under the MIRROR schema', async () => {
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const mirrors = makeMirrorsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async (schema, u) => {
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
    })
    const mirrorUID = uid(0xabc)
    const tx = await mirrors.remove(mirrorUID)
    expect(tx).toBe(uid(0xfee))
    expect(revokeCall).toEqual({ schema: SCHEMAS.mirror, uid: mirrorUID })
  })

  it('list reads getDataMirrors lens-scoped and maps the rows', async () => {
    const reads: { fn: string; args: readonly unknown[] }[] = []
    const mirrors = makeMirrorsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        reads.push({ fn, args })
        if (fn === 'getDataMirrors') {
          // first window returns one row, second (start>=50) returns empty → stops
          if ((args[2] as bigint) === 0n) {
            return [
              {
                uid: uid(0xa10),
                transportDefinition: IPFS_TRANSPORT,
                uri: 'ipfs://QmAAA',
                attester: ATTESTER,
                timestamp: 1n,
              },
            ]
          }
          return []
        }
        return uid(0)
      }) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const out = await mirrors.list(DATA)
    expect(out).toEqual([
      {
        uid: uid(0xa10),
        transportDefinition: IPFS_TRANSPORT,
        uri: 'ipfs://QmAAA',
        attester: ATTESTER,
      },
    ])
    // lens-scoped: the connected attester is passed as the second arg
    const first = reads.find((r) => r.fn === 'getDataMirrors')
    expect(first?.args[0]).toBe(DATA)
    expect(first?.args[1]).toBe(ATTESTER)
  })

  it('list fans across multiple lens attesters', async () => {
    const A = addr(0x1)
    const B = addr(0x2)
    const mirrors = makeMirrorsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getDataMirrors') {
          if ((args[2] as bigint) !== 0n) return []
          const who = args[1] as Address
          return [
            {
              uid: who === A ? uid(0xa1) : uid(0xb1),
              transportDefinition: IPFS_TRANSPORT,
              uri: who === A ? 'ipfs://A' : 'ipfs://B',
              attester: who,
              timestamp: 1n,
            },
          ]
        }
        return uid(0)
      }) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const out = await mirrors.list(DATA, { lens: [A, B] })
    expect(out.map((m) => m.uri)).toEqual(['ipfs://A', 'ipfs://B'])
  })
})
