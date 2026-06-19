/**
 * End-to-end test of the Tier-1 `efs.fs.write` orchestrator (`writes/file.ts`)
 * with **mocked viem clients** — no live chain. It exercises the full pipeline:
 *
 *   hashContent → resolveMirrors → resolveParentAnchor (mocked readContract) →
 *   buildFileWriteGraph → submitWriteTier1 (mocked writeContract + receipts) →
 *   WriteReceipt.
 *
 * The mock chain reuses the patterns from `writes-submit.test.ts`: a stub
 * `writeContract` that records each layer's flattened entries and fabricates one
 * `Attested` log per attestation in submission order, and a `waitForTransactionReceipt`
 * keyed by tx hash. The public client also answers `rootAnchorUID`/`resolvePath`
 * for parent resolution.
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
import type { EfsDeployment } from '../src/chain/deployments.js'
import { hashContent } from '../src/content/hash.js'
import { attestedEventAbi } from '../src/eas/abi.js'
import { ParentNotFoundError } from '../src/reads/resolve.js'
import { type FileWriteContext, writeFileTier1 } from '../src/writes/file.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const ZERO_UID = uid(0)
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address

const EAS = addr(0xea51)
const INDEXER = addr(0x1de6)
const ACCOUNT = addr(0xacc01)
const ROOT = uid(0x1)
const DOCS_ANCHOR = uid(0x10)
const TRANSPORT_DATA = uid(0x2d) // /transports/data anchor UID
const TRANSPORT_IPFS = uid(0x2f) // /transports/ipfs anchor UID

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

/** A deployment with a transports map recording the data + ipfs anchors. */
function makeDeployment(transports?: Record<string, Hex>): EfsDeployment {
  return {
    chainId: 31337,
    contracts: {
      eas: EAS,
      schemaRegistry: addr(0x5),
      indexer: INDEXER,
      router: addr(0x6),
      fileView: addr(0x7),
      edgeResolver: addr(0x8),
      mirrorResolver: addr(0x9),
      listResolver: addr(0xaa),
      listEntryResolver: addr(0xbb),
      listReader: addr(0xcc),
      aliasResolver: addr(0xdd),
      systemAccount: addr(0xee),
    },
    schemas: SCHEMAS,
    ...(transports !== undefined ? { transports } : {}),
  }
}

function attestedLog(schema: Hex, mintedUID: Hex, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: attestedEventAbi,
    eventName: 'Attested',
    args: {
      recipient: '0x0000000000000000000000000000000000000000',
      attester: ACCOUNT,
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

interface SentLayer {
  entries: { schema: Hex; refUID: Hex; data: Hex; revocable: boolean }[]
}

/**
 * Build the full mocked `FileWriteContext`. `edges` maps `parent|name → uid` for
 * `resolvePath`; default seeds `/docs`. `transports` controls the deployment map.
 */
function makeCtx(
  opts: {
    edges?: Record<string, Hex>
    transports?: Record<string, Hex>
  } = {},
): { ctx: FileWriteContext; sent: SentLayer[] } {
  const edges = opts.edges ?? { [`${ROOT}|docs`]: DOCS_ANCHOR }
  const sent: SentLayer[] = []
  let globalIndex = 0
  let callIndex = 0
  const receipts = new Map<Hex, TransactionReceipt>()

  const publicClient = {
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      if (args.functionName === 'rootAnchorUID') return ROOT
      if (args.functionName === 'resolvePath') {
        const [parent, name] = args.args as [Hex, string]
        return edges[`${parent}|${name}`] ?? ZERO_UID
      }
      throw new Error(`unexpected readContract ${args.functionName}`)
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      const r = receipts.get(hash)
      if (!r) throw new Error(`mock: no receipt for ${hash}`)
      return r
    },
  }

  const walletClient = {
    async writeContract(args: {
      args: readonly [
        readonly { schema: Hex; data: readonly { refUID: Hex; data: Hex; revocable: boolean }[] }[],
      ]
    }) {
      callIndex += 1
      const thisCall = callIndex
      const requests = args.args[0]
      const entries: SentLayer['entries'] = []
      for (const r of requests) {
        for (const d of r.data) {
          entries.push({ schema: r.schema, refUID: d.refUID, data: d.data, revocable: d.revocable })
        }
      }
      sent.push({ entries })
      const txHash = `0x${thisCall.toString(16).padStart(64, '0')}` as Hex
      const logs: Log[] = entries.map((e, i) =>
        attestedLog(e.schema, uid(0xd000 + globalIndex + i), i),
      )
      globalIndex += entries.length
      receipts.set(txHash, {
        transactionHash: txHash,
        status: 'success',
        logs,
        blockNumber: 1n,
      } as TransactionReceipt)
      return txHash
    },
  }

  const ctx = {
    publicClient,
    walletClient,
    deployment: makeDeployment(opts.transports ?? { data: TRANSPORT_DATA, ipfs: TRANSPORT_IPFS }),
    account: ACCOUNT,
    chain: undefined,
  } as unknown as FileWriteContext
  return { ctx, sent }
}

const CONTENT = new Uint8Array([1, 2, 3, 4])

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeFileTier1 — full Tier-1 path with inline data: fallback', () => {
  it('resolves deps, builds the graph, submits per layer, returns a populated receipt', async () => {
    const { ctx, sent } = makeCtx()
    const receipt = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      contentType: 'text/markdown',
    })

    // 3 DAG layers submitted (DATA / L2 / PINs). 13 attestations total for a full
    // fresh file with all 3 reserved-key triplets.
    expect(sent).toHaveLength(3)
    const total = sent.reduce((n, s) => n + s.entries.length, 0)
    expect(total).toBe(13)

    // Receipt: contentHash is the bare SHA-256 of the bytes (ADR-0006).
    expect(receipt.contentHash).toBe(hashContent(CONTENT))
    expect(receipt.mechanism).toBe('sequential')
    expect(receipt.status).toBe('confirmed')
    // One signature per layer.
    expect(receipt.signatureCount).toBe(3)
    // Every minted attestation is recorded as a done step (13 refs).
    expect(receipt.steps).toHaveLength(13)
    expect(receipt.steps.every((s) => s.done)).toBe(true)

    // The DATA ref points at the file's content-identity UID, resolved by the
    // connected account (the attester lenses key on).
    expect(receipt.data).toBeDefined()
    expect(receipt.data?.uid).toBe(uid(0xd000)) // DATA is the first minted (L1).
    expect(receipt.data?.resolvedBy).toBe(ACCOUNT)
    expect(receipt.data?.chainId).toBe(31337)
  })

  it('inlines content as a data: mirror using the deployment data transport', async () => {
    const { ctx, sent } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx)

    // The MIRROR lives in L2 (sent[1]); decode it to confirm a data: URI + the
    // data transport anchor. MIRROR schema = (bytes32 transportDefinition, string uri).
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntry = sent[1].entries.find((e) => e.schema === SCHEMAS.mirror)
    expect(mirrorEntry).toBeDefined()
    const [transportDef, uriValue] = mirrorEnc.decodeData(mirrorEntry!.data) as [Hex, string]
    expect(transportDef).toBe(TRANSPORT_DATA)
    expect(uriValue.startsWith('data:')).toBe(true)
  })
})

describe('writeFileTier1 — caller-supplied mirrors', () => {
  it('uses opts.mirrors and the per-scheme transport from the deployment map', async () => {
    const { ctx, sent } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ipfs://QmExample'],
    })
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntry = sent[1].entries.find((e) => e.schema === SCHEMAS.mirror)
    const [transportDef, uriValue] = mirrorEnc.decodeData(mirrorEntry!.data) as [Hex, string]
    expect(transportDef).toBe(TRANSPORT_IPFS) // keyed by the ipfs scheme
    expect(uriValue).toBe('ipfs://QmExample')
  })

  it('honors opts.transportDefinition over the deployment map', async () => {
    const override = uid(0x999)
    const { ctx, sent } = makeCtx({ transports: {} }) // empty map → must use override
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ipfs://QmExample'],
      transportDefinition: override,
    })
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntry = sent[1].entries.find((e) => e.schema === SCHEMAS.mirror)
    const [transportDef] = mirrorEnc.decodeData(mirrorEntry!.data) as [Hex, string]
    expect(transportDef).toBe(override)
  })
})

describe('writeFileTier1 — error paths', () => {
  it('throws ParentNotFoundError when the parent folder is missing', async () => {
    const { ctx } = makeCtx({ edges: {} }) // nothing under root
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(ParentNotFoundError)
    expect((err as ParentNotFoundError).missingSegment).toBe('docs')
  })

  it('throws MissingTransport when no data transport is recorded and none supplied', async () => {
    const { ctx } = makeCtx({ transports: {} }) // no data transport anchor
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('MissingTransport')
    expect(String((err as Error).message)).toMatch(/transports\/data/)
  })

  it('throws MissingTransport for a caller mirror whose scheme has no transport anchor', async () => {
    const { ctx } = makeCtx({ transports: { data: TRANSPORT_DATA } }) // ipfs missing
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ipfs://QmExample'],
    }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('MissingTransport')
    expect(String((err as Error).message)).toMatch(/ipfs/)
  })

  it('rejects oversized content with no mirrors (inline cap)', async () => {
    const { ctx } = makeCtx()
    const big = new Uint8Array(5 * 1024) // over MAX_INLINE_BYTES (4 KiB)
    const err = await writeFileTier1('/docs/big.bin', big, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/inline cap/)
  })
})
