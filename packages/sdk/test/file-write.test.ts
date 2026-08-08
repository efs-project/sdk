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
/** The `/transports` root — the boundary gate walks each transportDefinition's
 * parent chain up to it (MirrorResolver's InvalidTransport predicate). */
const TRANSPORTS_ROOT = uid(0x2b)
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
  /** The store's ERC-5219 `contentType_` constructor arg (`kind: 'manager'`). */
  managerContentType?: string
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
    /** Anchor UIDs the uploader already has an active visibility TAG on. The mock's
     * `getActiveTagWeight` returns `[true, 1n]` for these, `[false, 0n]` otherwise —
     * the short-circuit input for the ancestor-walk. */
    taggedAncestors?: readonly Hex[]
    /** Pre-existing DATA-typed file anchors, keyed `parent|name|schema → uid`, that the
     * overwrite probe (`resolveAnchor`) finds. Absent ⇒ a first write at the path. */
    anchors?: Record<string, Hex>
  } = {},
): { ctx: FileWriteContext; sent: SentLayer[]; deploys: SentDeploy[] } {
  const edges = opts.edges ?? { [`${ROOT}|docs`]: DOCS_ANCHOR }
  // The /transports subtree root this harness serves: the fixture's own edge
  // when it models one (the on-chain transport-resolution tests), else the
  // default. Transport anchors hang directly under it for the gate's walk.
  const transportsRoot = edges[`${ROOT}|transports`] ?? TRANSPORTS_ROOT
  const anchors = opts.anchors ?? {}
  const tagged = new Set<string>(opts.taggedAncestors ?? [])
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
        // The transports subtree is always present (the deployments the SDK
        // targets bootstrap it) — the transport gate resolves it by path.
        if (parent === ROOT && name === 'transports') return transportsRoot
        return edges[`${parent}|${name}`] ?? ZERO_UID
      }
      if (args.functionName === 'resolveAnchor') {
        // (parent, name, schema) — the DATA-typed file-anchor overwrite probe (Bug-1).
        // Keyed on `parent|name|schema`; absent ⇒ ZERO_UID (a first write at this path).
        const [parent, name, schema] = args.args as [Hex, string, Hex]
        return anchors[`${parent}|${name}|${schema}`] ?? ZERO_UID
      }
      if (args.functionName === 'getAttestation') {
        // The layered submitter's concrete-anchor gate (r3741288472/45): this
        // harness's overwrite anchors are genuine ANCHORs; reconstruct the slot
        // fields (parent, name, DATA bucket) from the `anchors` fixture keys.
        const [u] = args.args as [Hex]
        // Transport anchors live under /transports (the gate's ancestry walk).
        if (u === TRANSPORT_IPFS || u === TRANSPORT_ONCHAIN || u === transportsRoot) {
          return {
            uid: u,
            schema: SCHEMAS.anchor,
            refUID: u === transportsRoot ? ROOT : transportsRoot,
            data: encodeAbiParameters(
              [{ type: 'string' }, { type: 'bytes32' }],
              [
                u === TRANSPORT_IPFS ? 'ipfs' : u === TRANSPORT_ONCHAIN ? 'onchain' : 'transports',
                ZERO_UID,
              ],
            ),
          }
        }
        for (const [key, anchorUID] of Object.entries(anchors)) {
          if (anchorUID === u) {
            const [parent, name] = key.split('|') as [Hex, string]
            return {
              uid: u,
              schema: SCHEMAS.anchor,
              refUID: parent,
              data: encodeAbiParameters(
                [{ type: 'string' }, { type: 'bytes32' }],
                [name, SCHEMAS.data],
              ),
            }
          }
        }
        // Fallback: any other queried anchor in this harness is a transport
        // definition (custom overrides, ar://, the on-chain-resolved web3 one)
        // — model it as a direct child of /transports so the gate's ancestry
        // walk succeeds, matching the real bootstrapped subtree.
        return {
          uid: u,
          schema: SCHEMAS.anchor,
          refUID: transportsRoot,
          data: encodeAbiParameters(
            [{ type: 'string' }, { type: 'bytes32' }],
            ['transport', ZERO_UID],
          ),
        }
      }
      if (args.functionName === 'getActiveTagWeight') {
        // (attester, target, definition, targetSchema) — the active visibility-TAG
        // check. `target` is the folder anchor being walked.
        const [, target] = args.args as [Address, Hex, Hex, Hex]
        return tagged.has(target) ? [true, 1n] : [false, 0n]
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
    // Chunk-manager (EFSBytesStore) deploy: (address[] chunks, string contentType_).
    async deployContract(args: { args: readonly [readonly Address[], string] }) {
      deploys.push({ kind: 'manager', managerArgs: args.args[0], managerContentType: args.args[1] })
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

    // 4 DAG layers submitted (DATA / L2 / PINs / visibility TAGs). 14 attestations
    // total: the full 13-node fresh-file graph + 1 visibility TAG for the existing
    // `/docs` ancestor (untagged here), emitted last.
    expect(sent).toHaveLength(4)
    const total = sent.reduce((n, s) => n + s.entries.length, 0)
    expect(total).toBe(14)

    // The last layer is exactly the one visibility TAG, targeting the /docs anchor.
    const tagLayer = sent[3]
    expect(tagLayer.entries).toHaveLength(1)
    expect(tagLayer.entries[0].schema).toBe(SCHEMAS.tag)
    expect(tagLayer.entries[0].refUID).toBe(DOCS_ANCHOR)
    expect(tagLayer.entries[0].revocable).toBe(true)
    // TAG data = (definition = DATA schema UID, weight = 1).
    const { SchemaEncoder: TagEnc } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS: TagFields } = await import('../src/eas/schemas.js')
    const tagEnc = new TagEnc(TagFields.tag)
    const [tagDef, tagWeight] = tagEnc.decodeData(tagLayer.entries[0].data) as [Hex, bigint]
    expect(tagDef).toBe(SCHEMAS.data)
    expect(tagWeight).toBe(1n)

    // Receipt: contentHash is the bare SHA-256 of the bytes (ADR-0006).
    expect(receipt.contentHash).toBe(hashContent(CONTENT))
    expect(receipt.mechanism).toBe('sequential')
    expect(receipt.status).toBe('confirmed')
    // Honest wallet count: 4 EAS layers + 2 on-chain storage deploys (chunk + manager).
    expect(receipt.signatureCount).toBe(6)
    // Every minted attestation is recorded as a done step (14 refs).
    expect(receipt.steps).toHaveLength(14)
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

  it('threads opts.contentType into the EFSBytesStore deploy (standards-compliant web3://)', async () => {
    const { ctx, deploys } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, { contentType: 'text/markdown' })
    // The store reports the same MIME the write binds as the contentType PROPERTY, so a
    // bare web3://<store> self-describes in any ERC-5219 client. Omitted ⇒ '' (octet-stream).
    expect(deploys.find((d) => d.kind === 'manager')?.managerContentType).toBe('text/markdown')
  })

  it('deploys the store with an empty contentType when none is supplied', async () => {
    const { ctx, deploys } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx) // no opts.contentType
    expect(deploys.find((d) => d.kind === 'manager')?.managerContentType).toBe('')
  })
})

describe('transport gate before paid storage (review r3741715493)', () => {
  it('REFUSES a non-/transports/ transportDefinition BEFORE the chunk/manager deploys', async () => {
    // The auto-store path deploys (and pays for) the chunk + manager before the
    // submitter's boundary gate runs — an invalid transport would leave that
    // storage orphaned for a write that can never complete.
    const { ctx, deploys } = makeCtx()
    const orphan = uid(0xbad0)
    const orig = ctx.publicClient.readContract.bind(ctx.publicClient)
    ;(ctx.publicClient as { readContract: unknown }).readContract = async (a: {
      functionName: string
      args?: readonly unknown[]
    }) => {
      // The orphan anchor is a REAL anchor whose parent chain never reaches
      // /transports; everything else answers as usual.
      if (a.functionName === 'getAttestation' && (a.args as [Hex])[0] === orphan) {
        return { uid: orphan, schema: SCHEMAS.anchor, refUID: ZERO_UID }
      }
      return orig(a as never)
    }
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      transportDefinition: orphan,
    }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/not a descendant of \/transports\//)
    expect(deploys).toHaveLength(0) // nothing deployed, nothing paid
  })
})

describe('writeFileTier1 — caller-supplied mirrors', () => {
  it('does NOT count any storage tx (signatureCount = EAS layers only, no deploys)', async () => {
    const { ctx, sent, deploys } = makeCtx()
    const receipt = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ipfs://QmExample'],
    })
    // Caller hosts the bytes → no SSTORE2 store → signatureCount is purely the EAS
    // layers (contrast the on-chain default path, which adds 2 for chunk + manager).
    expect(deploys).toHaveLength(0)
    expect(receipt.signatureCount).toBe(sent.length)
  })

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

  it('resolves the web3 transport ON-CHAIN when the deployment map lacks it (Sepolia case)', async () => {
    const TRANSPORTS_ANCHOR = uid(0x77)
    const WEB3_TRANSPORT = uid(0x78)
    // The transports map has NO web3 entry (like the built-in Sepolia deployment), so the
    // default on-chain write must resolve the on-chain transport anchor. The web3:// scheme
    // stores under the anchor named `onchain` (NOT `web3`), so the walk resolves
    // /transports/onchain.
    const { ctx, sent } = makeCtx({
      transports: {},
      edges: {
        [`${ROOT}|docs`]: DOCS_ANCHOR,
        [`${ROOT}|transports`]: TRANSPORTS_ANCHOR,
        [`${TRANSPORTS_ANCHOR}|onchain`]: WEB3_TRANSPORT,
      },
    })
    await writeFileTier1('/docs/readme.md', CONTENT, ctx) // no mirrors → on-chain storage
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntry = sent[1].entries.find((e) => e.schema === SCHEMAS.mirror)
    const [transportDef] = mirrorEnc.decodeData(mirrorEntry!.data) as [Hex, string]
    expect(transportDef).toBe(WEB3_TRANSPORT) // resolved on-chain, not from the map
  })

  it('normalizes an ar:// mirror to the canonical arweave transport key', async () => {
    const ARWEAVE = uid(0x2a) // /transports/arweave anchor UID
    // The map is keyed by `arweave`, but the URI scheme is `ar` — must normalize,
    // else a valid ar:// write throws MissingTransport.
    const { ctx, sent } = makeCtx({ transports: { arweave: ARWEAVE } })
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ar://abcdEFGHtxid'],
    })
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntry = sent[1].entries.find((e) => e.schema === SCHEMAS.mirror)
    const [transportDef, uriValue] = mirrorEnc.decodeData(mirrorEntry!.data) as [Hex, string]
    expect(transportDef).toBe(ARWEAVE) // ar → arweave
    expect(uriValue).toBe('ar://abcdEFGHtxid')
  })

  it('labels each mirror of a mixed-scheme set with its OWN transport (ipfs + ar)', async () => {
    const ARWEAVE = uid(0x2a)
    const { ctx, sent } = makeCtx({
      transports: { ipfs: TRANSPORT_IPFS, arweave: ARWEAVE },
    })
    // A common durability pair — each MIRROR must get its own transport, not the
    // first URI's (the mislabeling bug this guards).
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['ipfs://QmExample', 'ar://txid'],
    })
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const mirrorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
    const mirrorEntries = sent[1].entries.filter((e) => e.schema === SCHEMAS.mirror)
    expect(mirrorEntries).toHaveLength(2)
    const decoded = mirrorEntries.map((e) => mirrorEnc.decodeData(e.data) as [Hex, string])
    expect(decoded).toContainEqual([TRANSPORT_IPFS, 'ipfs://QmExample'])
    expect(decoded).toContainEqual([ARWEAVE, 'ar://txid'])
  })
})

describe('writeFileTier1 — resume (not yet implemented)', () => {
  it('throws NotImplemented instead of silently re-sending landed layers', async () => {
    const { ctx, sent, deploys } = makeCtx()
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      resume: { opId: '0xdead' } as never, // a prior (partial) receipt
    }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('NotImplemented')
    // Fails closed up front — nothing deployed, nothing attested (no double-mint).
    expect(deploys).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

describe('writeFileTier1 — foreign author (not yet honored; renamed from lens per ADR-0019/R4)', () => {
  it('throws NotImplemented for an author other than the connected account', async () => {
    const { ctx, sent, deploys } = makeCtx()
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      author: addr(0xfeed), // != ACCOUNT (addr(0xacc01)) — Tier-1 always attests as the wallet
    }).catch((e) => e)
    // Fail fast rather than silently authoring under the wallet lens (the requested lens
    // would never see the file). Nothing irreversible ran.
    expect((err as { code?: string }).code).toBe('NotImplemented')
    expect(deploys).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('accepts a lens EQUAL to the connected account (harmless no-op)', async () => {
    const { ctx } = makeCtx()
    const receipt = await writeFileTier1('/docs/readme.md', CONTENT, ctx, { author: ACCOUNT })
    expect(receipt.status).toBe('confirmed')
  })
})

describe('writeFileTier1 — read-only planning before irreversible storage', () => {
  it('a failing visibility-tag read aborts BEFORE deploying on-chain bytes (no gas spent)', async () => {
    const { ctx, sent, deploys } = makeCtx()
    const origRead = ctx.publicClient.readContract.bind(ctx.publicClient)
    // The ancestor visibility-tag planning (getActiveTagWeight) is read-only and must run
    // BEFORE the SSTORE2 storage deploy — so a failure here costs no gas.
    ;(ctx.publicClient as { readContract: unknown }).readContract = async (a: {
      functionName: string
    }) => {
      if (a.functionName === 'getActiveTagWeight') throw new Error('tag read failed')
      return (origRead as (x: unknown) => Promise<unknown>)(a)
    }
    await expect(writeFileTier1('/docs/readme.md', CONTENT, ctx)).rejects.toThrow('tag read failed')
    expect(deploys).toHaveLength(0) // storage never deployed
    expect(sent).toHaveLength(0) // no attestations
  })

  it('re-asserts the live chain BEFORE the planning reads — a mid-write drift reads nothing, deploys nothing', async () => {
    const { ctx, sent, deploys } = makeCtx()
    let readCalled = false
    const origRead = ctx.publicClient.readContract.bind(ctx.publicClient)
    ;(ctx.publicClient as { readContract: unknown }).readContract = async (a: unknown) => {
      readCalled = true
      return (origRead as (x: unknown) => Promise<unknown>)(a)
    }
    // The public provider drifted after the caller's entry preflight: the in-routine guard
    // fails closed BEFORE any planning read (parent-anchor / visibility / transport) can bake
    // a wrong-chain UID into the plan. Nothing reads, nothing deploys, nothing attests.
    const guarded = {
      ...ctx,
      assertChain: async () => {
        throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
      },
    } as unknown as FileWriteContext
    const err = await writeFileTier1('/docs/readme.md', CONTENT, guarded).catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
    expect(readCalled).toBe(false) // no planning read ran
    expect(deploys).toHaveLength(0) // storage never deployed
    expect(sent).toHaveLength(0) // no attestations
  })
})

describe('writeFileTier1 — abort signal', () => {
  it('throws before any work when the signal is already aborted', async () => {
    const { ctx, sent, deploys } = makeCtx()
    await expect(
      writeFileTier1('/docs/readme.md', CONTENT, ctx, { signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    // No irreversible step ran: nothing deployed, nothing attested.
    expect(deploys).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('bails between layers when aborted mid-write (partial, not all layers sent)', async () => {
    const { ctx, sent } = makeCtx()
    const controller = new AbortController()
    const orig = ctx.walletClient.writeContract.bind(ctx.walletClient)
    let layers = 0
    // Abort right after the first layer's multiAttest mines — the per-layer check
    // must stop the next layer.
    ;(ctx.walletClient as { writeContract: unknown }).writeContract = async (a: unknown) => {
      const hash = await (orig as (x: unknown) => Promise<Hex>)(a)
      if (++layers === 1) controller.abort()
      return hash
    }
    await expect(
      writeFileTier1('/docs/readme.md', CONTENT, ctx, { signal: controller.signal }),
    ).rejects.toThrow()
    // The file write is a 3-layer DAG; aborting after layer 1 must leave it short.
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent.length).toBeLessThan(3)
  })
})

describe('writeFileTier1 — onProgress', () => {
  it('fires opts.onProgress once per layer with a consistent step/total', async () => {
    const { ctx } = makeCtx()
    const events: { step: number; total: number; phase: string }[] = []
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      onProgress: (p) => events.push(p),
    })
    // The DAG fires onLayer after each layer mines, so onProgress must fire at least
    // once (the documented callback was previously never wired → never invoked).
    expect(events.length).toBeGreaterThanOrEqual(1)
    // Every event shares the same total (the DAG's layer count) and reports an
    // in-range, strictly increasing layer step; phase is the layer-confirmed label.
    const total = events[0]?.total ?? 0
    expect(total).toBeGreaterThanOrEqual(events.length)
    events.forEach((e, i) => {
      expect(e.total).toBe(total)
      expect(e.step).toBe((events[i - 1]?.step ?? 0) + 1)
      expect(e.step).toBeLessThanOrEqual(total)
      expect(e.phase).toBe('layer-confirmed')
    })
  })

  it('omitting onProgress is a no-op (write still succeeds)', async () => {
    const { ctx } = makeCtx()
    const receipt = await writeFileTier1('/docs/readme.md', CONTENT, ctx)
    expect(receipt.status).toBe('confirmed')
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

  it('REGRESSION (r3740482349): a NaN/non-positive cap throws InvalidArgument — never waves oversized payloads into storage deploys', async () => {
    // NaN fails every comparison, so `byteLength > limit` would be false for ANY
    // size — two gas-spending deploys instead of PayloadTooLarge. Fail loud.
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const { ctx, deploys } = makeCtx({ onchainAutoLimit: bad })
      const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx).catch((e) => e)
      expect((err as { code?: string }).code, String(bad)).toBe('InvalidArgument')
      expect(deploys, String(bad)).toHaveLength(0) // no gas spent on garbage config
    }
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

describe('storage state on attestation failures (review r3740563977)', () => {
  it('a first-EAS-layer failure after the deploys carries the COMPLETED storage on the error', async () => {
    const { ctx, deploys } = makeCtx()
    // Both storage deploys succeed; the FIRST multiAttest (EAS layer) is rejected.
    const origWrite = ctx.walletClient.writeContract?.bind(ctx.walletClient)
    ;(ctx.walletClient as { writeContract: unknown }).writeContract = async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    }
    void origWrite
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx).catch((e) => e)
    expect(deploys).toHaveLength(2) // chunk + manager LANDED (irreversible)
    const w = err as { storage?: { web3Uri?: string; txHashes?: readonly unknown[] } }
    expect(w.storage).toBeDefined()
    expect(w.storage?.web3Uri).toMatch(/^web3:\/\/0x/)
    expect(w.storage?.txHashes).toHaveLength(2)
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

    // Layers: photos(1) → 2026(2) → DATA(3) → L2(4) → PINs(5) → visTAGs(6) = 6 EAS
    // layers. Both created folders (photos, 2026) get a visibility TAG (last layer);
    // root is never tagged.
    expect(sent).toHaveLength(6)
    // signatureCount is the HONEST wallet count: 6 EAS layers + 2 on-chain storage
    // deploys (chunk + manager) the default no-mirrors path sent first.
    expect(receipt.signatureCount).toBe(8)

    // The final layer is the two created-folder visibility TAGs, each targeting a
    // freshly-minted folder anchor (photos → uid(0xd000), 2026 → uid(0xd001)).
    const visTags = sent[5]
    expect(visTags.entries).toHaveLength(2)
    expect(visTags.entries.every((e) => e.schema === SCHEMAS.tag)).toBe(true)
    expect(visTags.entries.map((e) => e.refUID).sort()).toEqual([uid(0xd000), uid(0xd001)].sort())

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

    // One created folder → 5 layers (folder, DATA, L2, PINs, visTAGs). The TAG layer
    // covers BOTH the created `2026` folder and the existing (untagged) `/photos`.
    expect(sent).toHaveLength(5)
    const visTags = sent[4]
    // 2 TAGs: created `2026` (fresh anchor uid(0xd000)) + existing `/photos` (concrete).
    expect(visTags.entries).toHaveLength(2)
    expect(visTags.entries.map((e) => e.refUID).sort()).toEqual([uid(0xd000), PHOTOS_ANCHOR].sort())

    const file = anchors.find((a) => a.name === 'trip.jpg')!
    // file refs the mined 2026 UID (first minted, uid(0xd000)).
    expect(file.refUID).toBe(uid(0xd000))
    expect(y2026.layer).toBeLessThan(file.layer)
  })

  it('parent already exists + createParents:true: no extra folder anchors, base 3 layers', async () => {
    // /docs exists (default edge) → no folders to create.
    const { ctx, sent } = makeCtx()
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, { createParents: true })

    // base DATA / L2 / PINs + the visibility-TAG layer for the existing /docs.
    expect(sent).toHaveLength(4)
    const anchors = await anchorEntries(sent)
    // No 'docs' anchor is re-created; the file-ANCHOR refs the existing /docs anchor.
    expect(anchors.some((a) => a.name === 'docs')).toBe(false)
    const file = anchors.find((a) => a.name === 'readme.md')!
    expect(file.refUID).toBe(DOCS_ANCHOR)
  })
})

describe('writeFileTier1 — folder-visibility TAGs (overview.md step 7, ADR-0038/0041)', () => {
  // A three-deep existing tree /a/b/c; the file lands at /a/b/c/file.txt. The three
  // ancestor anchors (a, b, c) are the visibility-TAG walk's targets; root is never.
  const A = uid(0xa1)
  const B = uid(0xb2)
  const C = uid(0xc3)
  const DEEP_EDGES: Record<string, Hex> = {
    [`${ROOT}|a`]: A,
    [`${A}|b`]: B,
    [`${B}|c`]: C,
  }

  /** Collect every submitted TAG entry's target (refUID), across all layers. */
  const tagTargets = (sent: SentLayer[]): Hex[] =>
    sent.flatMap((l) => l.entries.filter((e) => e.schema === SCHEMAS.tag).map((e) => e.refUID))

  it('no ancestors tagged yet: emits one TAG per ancestor (a, b, c) — never root or the file', async () => {
    const { ctx, sent } = makeCtx({ edges: DEEP_EDGES })
    await writeFileTier1('/a/b/c/file.txt', CONTENT, ctx, { contentType: 'text/plain' })

    const targets = tagTargets(sent)
    // Exactly the three existing generic ancestors; root (ROOT) is excluded, and the
    // file's own leaf anchor (a fresh file ANCHOR) is never a TAG target.
    expect(targets.sort()).toEqual([A, B, C].sort())
    expect(targets).not.toContain(ROOT)
    // No TAG targets the file anchor (file anchors are minted fresh; assert none of
    // the TAG targets is a freshly-minted UID in the 0xd000 range used for new nodes).
    expect(targets.every((t) => t === A || t === B || t === C)).toBe(true)
  })

  it('every ancestor tagged: NO new TAGs at all (steady-state zero cost)', async () => {
    const { ctx, sent } = makeCtx({ edges: DEEP_EDGES, taggedAncestors: [A, B, C] })
    await writeFileTier1('/a/b/c/file.txt', CONTENT, ctx, { contentType: 'text/plain' })
    expect(tagTargets(sent)).toEqual([])
    // The base graph (no TAG layer) is the only thing submitted: DATA / L2 / PINs.
    expect(sent).toHaveLength(3)
  })

  it('REGRESSION (r3740584995): a HOLE above a tagged descendant is repaired — tagged nodes are skipped, not walk-terminators', async () => {
    // /a's tag was revoked while /a/b (B) stays tagged: the old first-tagged
    // short-circuit stopped at B and never re-tagged /a, leaving the branch
    // invisible from the root listing forever. The sweep now covers the FULL
    // chain (every read was already fetched): C (untagged) and A (the hole)
    // get TAGs; B is skipped.
    const { ctx, sent } = makeCtx({ edges: DEEP_EDGES, taggedAncestors: [B] })
    await writeFileTier1('/a/b/c/file.txt', CONTENT, ctx, { contentType: 'text/plain' })
    const targets = tagTargets(sent)
    expect(targets.slice().sort()).toEqual([C, A].sort())
    expect(targets).not.toContain(B)
  })
})

describe('writeFileTier1 — overwrite (reuse the existing file anchor, Bug-1)', () => {
  /** Flatten every submitted anchor entry, decoding its (name, forSchema). */
  const anchorNames = async (sent: SentLayer[]) => {
    const { SchemaEncoder } = await import('../src/eas/schema-encoder.js')
    const { EFS_SCHEMA_FIELDS } = await import('../src/eas/schemas.js')
    const anchorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
    const out: string[] = []
    for (const layer of sent) {
      for (const e of layer.entries) {
        if (e.schema === SCHEMAS.anchor) {
          const [name] = anchorEnc.decodeData(e.data) as [string, Hex]
          out.push(name)
        }
      }
    }
    return out
  }

  /** Decode the placement PIN's `definition` (the only PIN whose refUID is the DATA UID,
   * i.e. not a reserved-key binding PIN). Returns the decoded definition word. */
  const placementPinDefinition = async (sent: SentLayer[], dataUID: Hex): Promise<Hex> => {
    const { decodeAbiParameters } = await import('viem')
    for (const layer of sent) {
      for (const e of layer.entries) {
        if (e.schema === SCHEMAS.pin && e.refUID === dataUID) {
          const [def] = decodeAbiParameters([{ type: 'bytes32' }], e.data) as [Hex]
          return def
        }
      }
    }
    throw new Error('no placement PIN found')
  }

  const FILE_ANCHOR = uid(0x111) // a pre-existing DATA-typed file anchor at /docs/readme.md

  it('overwrite: emits NO file-ANCHOR; placement PIN definition = the existing anchor UID', async () => {
    const { ctx, sent } = makeCtx({
      anchors: { [`${DOCS_ANCHOR}|readme.md|${SCHEMAS.data}`]: FILE_ANCHOR },
    })
    const receipt = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      contentType: 'text/markdown',
    })

    // No file-ANCHOR named `readme.md` was minted (the existing one is reused).
    const names = await anchorNames(sent)
    expect(names).not.toContain('readme.md')
    // The reserved-key anchors (contentType/contentHash/size) ARE freshly minted.
    expect(names).toContain('contentHash')
    expect(names).toContain('size')

    // The placement PIN points at the CONCRETE existing anchor (not a fresh symbolic).
    const dataUID = receipt.data?.uid as Hex
    expect(await placementPinDefinition(sent, dataUID)).toBe(FILE_ANCHOR)
  })

  it('first write (anchor ABSENT): still mints the file-ANCHOR fresh', async () => {
    const { ctx, sent } = makeCtx() // no `anchors` → resolveAnchor returns ZERO_UID
    await writeFileTier1('/docs/readme.md', CONTENT, ctx, { contentType: 'text/markdown' })
    const names = await anchorNames(sent)
    expect(names).toContain('readme.md') // minted fresh
  })

  it('overwrite reuses the anchor but still mints fresh DATA + MIRROR (new content)', async () => {
    const { ctx, sent } = makeCtx({
      anchors: { [`${DOCS_ANCHOR}|readme.md|${SCHEMAS.data}`]: FILE_ANCHOR },
    })
    await writeFileTier1('/docs/readme.md', CONTENT, ctx)
    const dataEntries = sent.flatMap((l) => l.entries.filter((e) => e.schema === SCHEMAS.data))
    const mirrorEntries = sent.flatMap((l) => l.entries.filter((e) => e.schema === SCHEMAS.mirror))
    expect(dataEntries).toHaveLength(1) // a fresh DATA hub
    expect(mirrorEntries.length).toBeGreaterThanOrEqual(1) // a fresh MIRROR
  })

  it('a second setOverview (README anchor already exists) succeeds: no duplicate anchor, TAG on the existing one', async () => {
    // A second `efs.fs.setOverview` on the same folder = a markdown overwrite of the
    // existing /docs/README.md whose DATA-typed anchor already exists. It must NOT
    // re-mint the file-ANCHOR (which would revert DuplicateFileName); the cardinality-1
    // placement PIN supersedes. setOverview routes through writeFileTier1 with the
    // `overviewSystemTagDef` marker set on the context — simulate that here.
    const SYSTEM_DEF = uid(0x5751)
    const README_ANCHOR = uid(0x222)
    const { ctx, sent } = makeCtx({
      anchors: { [`${DOCS_ANCHOR}|README.md|${SCHEMAS.data}`]: README_ANCHOR },
    })
    ;(ctx as { overviewSystemTagDef?: Hex }).overviewSystemTagDef = SYSTEM_DEF
    const receipt = await writeFileTier1('/docs/README.md', CONTENT, ctx, {
      contentType: 'text/markdown',
    })

    // No second README.md anchor minted.
    const names = await anchorNames(sent)
    expect(names).not.toContain('README.md')

    // The Overview `system` TAG targets the fresh DATA (r3741476421): the
    // on-chain filter's FILE branch keys exclusion off resolved DATA UIDs, so
    // an anchor-targeted marker would never hide the README.
    const dataStep = receipt.steps.find((st) => st.id === 'DATA')
    expect(dataStep?.uid).toBeDefined()
    const systemTag = sent
      .flatMap((l) => l.entries)
      .find((e) => e.schema === SCHEMAS.tag && e.refUID === dataStep?.uid)
    expect(systemTag).toBeDefined()

    // The placement PIN's definition is the existing anchor too.
    const dataUID = receipt.data?.uid as Hex
    expect(await placementPinDefinition(sent, dataUID)).toBe(README_ANCHOR)
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
    // web3:// resolves the on-chain anchor named `onchain` (not `web3`).
    expect(String((err as Error).message)).toMatch(/transports\/onchain/)
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

  it('throws InvalidArgument for an explicitly empty mirrors list (no silent on-chain store)', async () => {
    // Supplying `mirrors` means the bytes already live off-chain; an empty list must be
    // a caller error, NOT a fall-through to on-chain auto-store (which would spend gas +
    // publish bytes against the WriteOptions.mirrors contract).
    const { ctx, deploys, sent } = makeCtx({ transports: { onchain: TRANSPORT_ONCHAIN } })
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, { mirrors: [] }).catch(
      (e) => e,
    )
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    // Nothing irreversible ran: no on-chain deploy, no attestation.
    expect(deploys).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('throws InvalidArgument for an empty/blank mirror URI even with an explicit transport', async () => {
    // `mirrors: ['']` + an explicit transportDefinition bypasses the scheme check, so an
    // empty URI would map into the MIRROR plan and revert at the L2 MIRROR batch AFTER
    // the L1 DATA landed (orphaned partial write). Reject it before any tx.
    const { ctx, deploys, sent } = makeCtx({ transports: { onchain: TRANSPORT_ONCHAIN } })
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['', 'ipfs://QmExample'],
      transportDefinition: TRANSPORT_ONCHAIN, // explicit → would skip the scheme guard
    }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(deploys).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('throws InvalidArgument for a mirror URI over MirrorResolver’s 8192-byte limit', async () => {
    // An oversized URI reverts at the L2 MIRROR batch (MAX_URI_LENGTH) — after L1 DATA has
    // mined — orphaning a partial write. Preflight the UTF-8 byte length before any tx.
    const huge = `ipfs://${'a'.repeat(8200)}` // > 8192 bytes (all ASCII)
    const { ctx, deploys, sent } = makeCtx({ transports: { ipfs: TRANSPORT_IPFS } })
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: [huge],
    }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/8192-byte limit/)
    expect(deploys).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('throws MissingTransport for a schemeless caller mirror (before any on-chain resolution)', async () => {
    // A URI with no `scheme:` prefix must be rejected up front: without a scheme the
    // transport fallback would resolve `/transports/` (the transport ROOT) and bind an
    // unfetchable mirror — or revert at the MIRROR layer after earlier attestations have
    // already landed. Mirror efs.mirrors.add's schemeless rejection.
    const { ctx } = makeCtx({ transports: { onchain: TRANSPORT_ONCHAIN } })
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      mirrors: ['not-a-uri'],
    }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('MissingTransport')
    expect(String((err as Error).message)).toMatch(/no 'scheme:' prefix/)
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

describe('storage survives FIRST-layer preflight failures (review r3740688505)', () => {
  it('an abort between the landed deploys and the first EAS layer wraps with .storage', async () => {
    const { ctx, deploys } = makeCtx()
    const controller = new AbortController()
    // Fire the abort as the MANAGER deploy returns — storage fully landed,
    // the first EAS layer not yet sent. The submitter's preflight abort
    // previously escaped RAW with no storage attached.
    const origDeploy = ctx.walletClient.deployContract.bind(ctx.walletClient)
    ;(ctx.walletClient as { deployContract: unknown }).deployContract = async (a: unknown) => {
      const h = await (origDeploy as (x: unknown) => Promise<unknown>)(a)
      controller.abort()
      return h
    }
    const err = await writeFileTier1('/docs/readme.md', CONTENT, ctx, {
      signal: controller.signal,
    }).catch((e) => e)
    expect(deploys).toHaveLength(2) // storage landed and is paid for
    const w = err as { storage?: { web3Uri?: string }; cause?: unknown }
    expect(w.storage?.web3Uri).toMatch(/^web3:\/\/0x/)
    expect(String((w.cause as Error)?.name ?? w.cause)).toMatch(/Abort/i)
  })
})
