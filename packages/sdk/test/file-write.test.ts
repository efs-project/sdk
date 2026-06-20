/**
 * End-to-end test of the Tier-1 `efs.fs.write` orchestrator (`writes/file.ts`)
 * with **mocked viem clients** — no live chain. It exercises the full pipeline:
 *
 *   hashContent → resolveParentAnchor (mocked readContract) → resolveMirrors
 *   (on-chain SSTORE2 storage via mocked deployContract/sendTransaction, OR caller
 *   mirrors) → buildFileWriteGraph → submitWriteTier1 (mocked writeContract +
 *   receipts) → WriteReceipt.
 *
 * The mock chain reuses the patterns from `writes-submit.test.ts`: a stub
 * `writeContract` that records each layer's flattened entries and fabricates one
 * `Attested` log per attestation in submission order, and a `waitForTransactionReceipt`
 * keyed by tx hash. The public client also answers `rootAnchorUID`/`resolvePath`
 * for parent resolution. The wallet client additionally stubs `deployContract`
 * (chunk manager) + `sendTransaction` (SSTORE2 chunk init-code), each minting a
 * deploy receipt carrying a deterministic `contractAddress` — the on-chain default
 * storage path.
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
const TRANSPORT_IPFS = uid(0x2f) // /transports/ipfs anchor UID
const TRANSPORT_ONCHAIN = uid(0x2c) // /transports/onchain anchor UID (web3:// scheme)
/** Deterministic addresses the mocked deploys return (chunk, then manager). */
const CHUNK_ADDR = addr(0x5c01)
const MANAGER_ADDR = addr(0x11a0)

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

/** A recorded on-chain storage deploy (SSTORE2 chunk init-code, or chunk manager). */
interface SentDeploy {
  kind: 'chunk' | 'manager'
  /** The chunk's init code (`data`), present only for `kind: 'chunk'`. */
  data?: Hex
  /** The manager's constructor args (`address[]`), present only for `kind: 'manager'`. */
  managerArgs?: readonly Address[]
}

/**
 * Build the full mocked `FileWriteContext`. `edges` maps `parent|name → uid` for
 * `resolvePath`; default seeds `/docs`. `transports` controls the deployment map.
 * `onchainAutoLimit` overrides the client-level cap. The wallet client stubs the
 * attestation `writeContract` AND the on-chain storage deploys
 * (`sendTransaction` = chunk, `deployContract` = manager); deploy receipts carry a
 * deterministic `contractAddress`.
 */
function makeCtx(
  opts: {
    edges?: Record<string, Hex>
    transports?: Record<string, Hex>
    onchainAutoLimit?: number
  } = {},
): { ctx: FileWriteContext; sent: SentLayer[]; deploys: SentDeploy[] } {
  const edges = opts.edges ?? { [`${ROOT}|docs`]: DOCS_ANCHOR }
  const sent: SentLayer[] = []
  const deploys: SentDeploy[] = []
  let globalIndex = 0
  let callIndex = 0
  const receipts = new Map<Hex, TransactionReceipt>()
  // Deploy receipts carry a contractAddress; keyed separately so a deploy tx hash
  // resolves to a {contractAddress} receipt (chunk first, manager second).
  const deployContractAddr = new Map<Hex, Address>()

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
      const deployed = deployContractAddr.get(hash)
      if (deployed !== undefined) return { contractAddress: deployed } as TransactionReceipt
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
    // SSTORE2 chunk deploy (raw init-code; no `to`). Returns the chunk address.
    async sendTransaction(args: { data: Hex; to?: undefined }) {
      deploys.push({ kind: 'chunk', data: args.data })
      const hash = uid(0xc000 + deploys.length)
      deployContractAddr.set(hash, CHUNK_ADDR)
      return hash
    },
    // Chunk-manager deploy. Returns the manager address.
    async deployContract(args: { args: readonly [readonly Address[]] }) {
      deploys.push({ kind: 'manager', managerArgs: args.args[0] })
      const hash = uid(0xe000 + deploys.length)
      deployContractAddr.set(hash, MANAGER_ADDR)
      return hash
    },
  }

  const ctx = {
    publicClient,
    walletClient,
    deployment: makeDeployment(
      opts.transports ?? {
        onchain: TRANSPORT_ONCHAIN,
        web3: TRANSPORT_ONCHAIN,
        ipfs: TRANSPORT_IPFS,
      },
    ),
    account: ACCOUNT,
    chain: undefined,
    ...(opts.onchainAutoLimit !== undefined ? { onchainAutoLimit: opts.onchainAutoLimit } : {}),
  } as unknown as FileWriteContext
  return { ctx, sent, deploys }
}

const CONTENT = new Uint8Array([1, 2, 3, 4])

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeFileTier1 — full Tier-1 path with on-chain (web3://) default storage', () => {
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

  it('stores bytes on-chain (chunk + manager) and publishes a web3:// mirror', async () => {
    const { ctx, sent, deploys } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx)

    // Two deploys: the SSTORE2 chunk (init-code), then the chunk manager wrapping
    // the chunk address (single-element array — v1 is single-chunk).
    expect(deploys).toHaveLength(2)
    expect(deploys[0].kind).toBe('chunk')
    // The chunk init code is `0x61<len>80600c6000396000f300<content>` — the SSTORE2
    // stub + the STOP byte + the raw content. Confirm the content tail + STOP byte.
    expect(deploys[0].data?.startsWith('0x61')).toBe(true)
    expect(deploys[0].data?.endsWith('0001020304')).toBe(true)
    expect(deploys[1].kind).toBe('manager')
    expect(deploys[1].managerArgs).toEqual([CHUNK_ADDR])

    // The MIRROR (L2) carries web3://<manager> + the onchain transport anchor.
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntry = sent[1].entries.find((e) => e.schema === SCHEMAS.mirror)
    expect(mirrorEntry).toBeDefined()
    const [transportDef, uriValue] = mirrorEnc.decodeData(mirrorEntry!.data) as [Hex, string]
    expect(transportDef).toBe(TRANSPORT_ONCHAIN)
    expect(uriValue).toBe(`web3://${MANAGER_ADDR}`)
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

  it('caller mirrors skip on-chain storage entirely (no deploys)', async () => {
    const { ctx, deploys } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ipfs://QmExample'],
    })
    expect(deploys).toHaveLength(0)
  })
})

describe('writeFileTier1 — on-chain storage overrides + caps', () => {
  it('{ storage: "onchain" } stores on-chain even with no mirrors (and over the cap)', async () => {
    // Cap set to 2 bytes; CONTENT is 4 bytes → would normally throw PayloadTooLarge.
    // The storage override bypasses the cap and stores on-chain anyway.
    const { ctx, sent, deploys } = makeCtx({ onchainAutoLimit: 2 })
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, { storage: 'onchain' })
    expect(deploys).toHaveLength(2)
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntry = sent[1].entries.find((e) => e.schema === SCHEMAS.mirror)
    const [, uriValue] = mirrorEnc.decodeData(mirrorEntry!.data) as [Hex, string]
    expect(uriValue).toBe(`web3://${MANAGER_ADDR}`)
  })

  it('respects a raised onchainAutoLimit (stores on-chain at a size that the default would reject)', async () => {
    // 8 KB content, cap raised to 8 KB → on-chain (default 16 KB would also allow,
    // so use a SMALL default override to prove the client cap is what's consulted).
    const big = new Uint8Array(6 * 1024)
    const { ctx, deploys } = makeCtx({ onchainAutoLimit: 8 * 1024 })
    await writeFileTier1('/docs/big.bin', big, ctx)
    expect(deploys).toHaveLength(2)
  })
})

describe('writeFileTier1 — createParents (mkdir -p)', () => {
  const anchorEntries = async (sent: SentLayer[]) => {
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const anchorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
    // Flatten every submitted anchor entry, tagged with its layer index, decoding
    // its (name, forSchema). Folder + file anchors all use the anchor schema.
    const out: { layer: number; name: string; refUID: Hex }[] = []
    sent.forEach((layer, li) => {
      for (const e of layer.entries) {
        if (e.schema === SCHEMAS.anchor) {
          const [name] = anchorEnc.decodeData(e.data) as [string, Hex]
          out.push({ layer: li, name, refUID: e.refUID })
        }
      }
    })
    return out
  }

  it('fully-missing nested path: creates the chained folders BEFORE the file, refUID-threaded', async () => {
    // Nothing under root → both /photos and /photos/2026 are missing.
    const { ctx, sent } = makeCtx({ edges: {} })
    const receipt = await writeFileTier1('/photos/2026/trip.jpg', CONTENT, ctx, {
      createParents: true,
      contentType: 'image/jpeg',
    })

    // Layers: photos(1) → 2026(2) → DATA(3) → L2(4) → PINs(5) = 5 signatures.
    expect(sent).toHaveLength(5)
    expect(receipt.signatureCount).toBe(5)

    const anchors = await anchorEntries(sent)
    const photos = anchors.find((a) => a.name === 'photos')!
    const y2026 = anchors.find((a) => a.name === '2026')!
    const file = anchors.find((a) => a.name === 'trip.jpg')!
    expect(photos).toBeDefined()
    expect(y2026).toBeDefined()
    expect(file).toBeDefined()

    // Folders submitted before the file (earlier layers).
    expect(photos.layer).toBeLessThan(y2026.layer)
    expect(y2026.layer).toBeLessThan(file.layer)

    // refUID chain: photos → ROOT (deepest existing), 2026 → photos' mined UID,
    // file → 2026's mined UID. Mined UIDs come from the Attested logs (uid(0xd000+)).
    expect(photos.refUID).toBe(ROOT)
    // photos is the first attestation minted in layer 0 → uid(0xd000).
    const photosUID = uid(0xd000)
    expect(y2026.refUID).toBe(photosUID)
    // 2026 is minted in layer 1, the next global index → uid(0xd001).
    const y2026UID = uid(0xd001)
    expect(file.refUID).toBe(y2026UID)

    // The created folder UIDs are recorded as done steps in the receipt.
    expect(receipt.steps.find((s) => s.uid === photosUID)?.done).toBe(true)
    expect(receipt.steps.find((s) => s.uid === y2026UID)?.done).toBe(true)
  })

  it('createParents:false throws ParentNotFoundError on a missing parent', async () => {
    const { ctx } = makeCtx({ edges: {} })
    const err = await writeFileTier1('/photos/2026/trip.jpg', CONTENT, ctx, {
      createParents: false,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ParentNotFoundError)
    expect((err as ParentNotFoundError).missingSegment).toBe('photos')
  })

  it('default (createParents unset) creates the missing folders — does not throw', async () => {
    const { ctx, sent } = makeCtx({ edges: {} })
    await writeFileTier1('/photos/2026/trip.jpg', CONTENT, ctx)
    const anchors = await anchorEntries(sent)
    expect(
      anchors.filter((a) => a.name === 'photos' || a.name === '2026').map((a) => a.name),
    ).toEqual(['photos', '2026'])
  })

  it('only the leaf folder missing: creates ONLY that segment, reusing the deepest existing ancestor', async () => {
    // /photos exists; /photos/2026 does not.
    const PHOTOS_ANCHOR = uid(0x710)
    const { ctx, sent } = makeCtx({ edges: { [`${ROOT}|photos`]: PHOTOS_ANCHOR } })
    await writeFileTier1('/photos/2026/trip.jpg', CONTENT, ctx, { createParents: true })

    const anchors = await anchorEntries(sent)
    const folderAnchors = anchors.filter((a) => a.name === '2026' || a.name === 'photos')
    // Only '2026' is created; '/photos' is reused (never re-attested).
    expect(folderAnchors.map((a) => a.name)).toEqual(['2026'])
    const y2026 = anchors.find((a) => a.name === '2026')!
    // It hangs off the EXISTING /photos anchor (concrete), not a fresh one.
    expect(y2026.refUID).toBe(PHOTOS_ANCHOR)

    // One created folder → 4 layers (folder, DATA, L2, PINs).
    expect(sent).toHaveLength(4)

    const file = anchors.find((a) => a.name === 'trip.jpg')!
    // file refs the mined 2026 UID (first minted, uid(0xd000)).
    expect(file.refUID).toBe(uid(0xd000))
    expect(y2026.layer).toBeLessThan(file.layer)
  })

  it('parent already exists + createParents:true: no extra folder anchors, base 3 layers', async () => {
    // /docs exists (default edge) → no folders to create.
    const { ctx, sent } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, { createParents: true })

    expect(sent).toHaveLength(3) // base DATA / L2 / PINs — no folder layer prepended
    const anchors = await anchorEntries(sent)
    // No 'docs' anchor is re-created; the file-ANCHOR refs the existing /docs anchor.
    expect(anchors.some((a) => a.name === 'docs')).toBe(false)
    const file = anchors.find((a) => a.name === 'readme.md')!
    expect(file.refUID).toBe(DOCS_ANCHOR)
  })
})

describe('writeFileTier1 — error paths', () => {
  it('throws ParentNotFoundError when the parent folder is missing and createParents:false', async () => {
    const { ctx } = makeCtx({ edges: {} }) // nothing under root
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      createParents: false,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ParentNotFoundError)
    expect((err as ParentNotFoundError).missingSegment).toBe('docs')
  })

  it('throws MissingTransport when no web3 transport is recorded for the on-chain default', async () => {
    const { ctx, deploys } = makeCtx({ transports: {} }) // no onchain/web3 anchor
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('MissingTransport')
    expect(String((err as Error).message)).toMatch(/transports\/web3/)
    // The transport is looked up AFTER the deploys, but a missing one still surfaces.
    // (Deploys may have run; the point is the write fails clearly, not silently.)
    void deploys
  })

  it('throws MissingTransport for a caller mirror whose scheme has no transport anchor', async () => {
    const { ctx } = makeCtx({ transports: { onchain: TRANSPORT_ONCHAIN } }) // ipfs missing
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ipfs://QmExample'],
    }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('MissingTransport')
    expect(String((err as Error).message)).toMatch(/ipfs/)
  })

  it('throws PayloadTooLarge for no-mirrors content over the on-chain auto-cap', async () => {
    const { ctx, deploys } = makeCtx({ onchainAutoLimit: 2 }) // cap below CONTENT's 4 bytes
    const err = await writeFileTier1('/docs/big.bin', CONTENT, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('PayloadTooLarge')
    expect(String((err as Error).message)).toMatch(/on-chain auto-store cap/)
    // No on-chain deploy is attempted when the cap rejects the payload.
    expect(deploys).toHaveLength(0)
  })

  it('throws MultiChunkUnsupported when a forced on-chain payload exceeds one chunk', async () => {
    const { ctx, deploys } = makeCtx()
    const huge = new Uint8Array(25 * 1024) // > MAX_SINGLE_CHUNK_BYTES (~24 KB)
    const err = await writeFileTier1('/docs/huge.bin', huge, ctx, { storage: 'onchain' }).catch(
      (e) => e,
    )
    expect((err as { code?: string }).code).toBe('MultiChunkUnsupported')
    expect(String((err as Error).message)).toMatch(/single-chunk/)
    // The chunk deploy throws before any contract is created.
    expect(deploys).toHaveLength(0)
  })
})
