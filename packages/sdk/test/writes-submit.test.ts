import {
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem'
import { describe, expect, it } from 'vitest'
import type { EfsSchemaUIDs } from '../src/chain/deployments.js'
import { hashContent } from '../src/content/hash.js'
import { attestedEventAbi } from '../src/eas/abi.js'
import { SchemaEncoder } from '../src/eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../src/eas/schemas.js'
import { buildFileWriteGraph } from '../src/writes/graph.js'
import {
  type SubmitContext,
  type SubmitPublicClient,
  type SubmitWalletClient,
  WriteNotSentError,
  WriteRevertedError,
  WriteSendUnknownError,
  WriteUidsUnknownError,
  submitWriteTier1,
} from '../src/writes/submit.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const ZERO_UID = uid(0)

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

const EAS: Address = '0x000000000000000000000000000000000000eA51'
const PARENT = uid(0x100)
const TRANSPORT = uid(0x200)
const ROOT_ANCHOR = uid(0x1) // the transport gate's root lookup
const TRANSPORTS_ROOT = uid(0x2b) // /transports — every TRANSPORT hangs under it
const CONTENT_HASH = hashContent(new Uint8Array([1, 2, 3])) // must MATCH the bytes
const EXISTING_DATA = uid(0x400)
const EXISTING_ANCHOR = uid(0xea00)
const ACCOUNT: Address = '0x00000000000000000000000000000000000acc01'

const baseInput = {
  path: '/docs/readme.md',
  mirrors: [{ uri: 'ipfs://QmExample', transportDefinition: TRANSPORT }] as const,
  contentType: 'text/markdown',
  contentHash: CONTENT_HASH,
  size: 3n,
  schemas: SCHEMAS,
  parentAnchorUID: PARENT,
  fileName: 'readme.md',
} as const

const bytesInput = {
  ...baseInput,
  content: { kind: 'bytes' as const, bytes: new Uint8Array([1, 2, 3]) },
}

/** baseInput minus the byte-write metadata — HARDLINK inputs carry none (the
 * builder now REJECTS stray metadata instead of discarding it, r3741086780). */
const {
  mirrors: _hlM,
  contentHash: _hlH,
  size: _hlS,
  contentType: _hlT,
  ...hardlinkBase
} = baseInput
void [_hlM, _hlH, _hlS, _hlT]

const pinEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)

// ── Mock chain ──────────────────────────────────────────────────────────────

type MultiAttestArgs = SubmitWalletClient extends {
  writeContract(args: infer A): unknown
}
  ? A
  : never

interface SentLayer {
  args: MultiAttestArgs
  /** Flattened (schema-grouped) entries in EAS emission order. */
  entries: { schema: Hex; refUID: Hex; data: Hex; revocable: boolean }[]
}

/**
 * Build a fabricated `Attested` log for the EAS contract, carrying `mintedUID` in
 * the non-indexed `uid` field. The three indexed params are filled with the
 * fixed EFS recipient (0x0), the attester, and the schema — viem decodes them
 * back, but the submitter only reads `uid`.
 */
function attestedLog(
  address: Address,
  attester: Address,
  schema: Hex,
  mintedUID: Hex,
  logIndex: number,
): Log {
  const topics = encodeEventTopics({
    abi: attestedEventAbi,
    eventName: 'Attested',
    args: { recipient: '0x0000000000000000000000000000000000000000', attester, schemaUID: schema },
  })
  const data = encodeAbiParameters([{ name: 'uid', type: 'bytes32' }], [mintedUID])
  return {
    address,
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

interface MockChainOptions {
  /** Deterministic minted UID for the i-th attestation across the whole write
   * (global counter). Defaults to `0xD000 + i`. */
  mintUID?: (globalIndex: number) => Hex
  /** Override the DATA author the mock EAS reports (the hardlink gate read). */
  hardlinkAuthor?: Address
  /** Override the schema the mock EAS reports for the hardlink target. */
  hardlinkSchema?: Hex
  /** Override the submitter's mirror count on the hardlink target (default 1n). */
  hardlinkMirrorCount?: bigint
  /** Override the schema the mock reports for EXISTING_ANCHOR (default ANCHOR). */
  anchorSchema?: Hex
  /** Override EXISTING_ANCHOR's slot parent (default PARENT). */
  anchorParent?: Hex
  /** Override EXISTING_ANCHOR's slot name (default 'readme.md'). */
  anchorName?: string
  /** Layer (1-based call index) at which `writeContract` throws a CODED refusal. */
  revertOnCall?: number
  /** Layer at which `writeContract` fails with a CODE-LESS transport error. */
  transportErrorOnCall?: number
  /** Layer (1-based call index) whose receipt reports `status: 'reverted'`. */
  receiptRevertOnCall?: number
  /** Layer (1-based call index) whose `waitForTransactionReceipt` THROWS (the tx was
   * sent — a hash exists — but the receipt wait failed; outcome unknown). */
  receiptThrowOnCall?: number
  /** Address the fabricated `Attested` logs are emitted from (defaults to EAS). */
  emitFrom?: Address
  /** Extra non-EAS Attested logs to splice into every receipt (noise filter test). */
  extraNoiseLog?: boolean
  /** Force a wrong UID count in the receipt (drop the last log). */
  dropLastLog?: boolean
}

function makeMockChain(opts: MockChainOptions = {}) {
  const sent: SentLayer[] = []
  let globalIndex = 0
  let callIndex = 0
  const mint = opts.mintUID ?? ((i) => uid(0xd000 + i))
  const emitFrom = opts.emitFrom ?? EAS

  // Map a sent tx hash to the receipt the public client should return.
  const receipts = new Map<Hex, TransactionReceipt>()

  const walletClient: SubmitWalletClient = {
    async writeContract(args) {
      callIndex += 1
      const thisCall = callIndex
      if (opts.revertOnCall === thisCall) {
        // A REFUSAL RESPONSE: carries a JSON-RPC code, so the classifier can
        // prove the node answered (→ WriteNotSentError, mode (a)). Code-less
        // transport loss is the separate `transportErrorOnCall` (mode (a′)).
        throw Object.assign(
          new Error(`mock revert at call ${thisCall} (execution reverted: NotRevocable)`),
          { code: -32000 },
        )
      }
      if (opts.transportErrorOnCall === thisCall) {
        throw new Error('fetch failed: socket hang up') // NO code anywhere — pure transport loss
      }

      // Flatten the schema-grouped requests in EAS emission order.
      const requests = args.args[0]
      const entries: SentLayer['entries'] = []
      for (const r of requests) {
        for (const d of r.data) {
          entries.push({ schema: r.schema, refUID: d.refUID, data: d.data, revocable: d.revocable })
        }
      }
      sent.push({ args, entries })

      const txHash = `0x${thisCall.toString(16).padStart(64, '0')}` as Hex

      // Fabricate one Attested log per entry, in submission order.
      const logs: Log[] = entries.map((e, i) =>
        attestedLog(emitFrom, ACCOUNT, e.schema, mint(globalIndex + i), i),
      )
      globalIndex += entries.length

      if (opts.extraNoiseLog) {
        // A foreign contract emitting an identical-shaped Attested event — must be
        // filtered out by address.
        logs.push(
          attestedLog(
            '0x00000000000000000000000000000000000bad01',
            ACCOUNT,
            SCHEMAS.pin,
            uid(0xdead),
            logs.length,
          ),
        )
      }
      if (opts.dropLastLog) logs.pop()

      const status: 'success' | 'reverted' =
        opts.receiptRevertOnCall === thisCall ? 'reverted' : 'success'

      receipts.set(txHash, {
        transactionHash: txHash,
        status,
        logs,
        blockNumber: 1n,
      } as TransactionReceipt)

      return txHash
    },
  }

  const publicClient: SubmitPublicClient = {
    // The hardlink self-authorship gate's EAS read (r3741157003): by default the
    // mock reports the submitting ACCOUNT as the DATA author (self-authored);
    // `hardlinkAuthor` overrides it to simulate a foreign DATA.
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      // The transport gate's ancestry lookup: /transports resolves to a fixed
      // root and every transport anchor in this harness hangs directly under it.
      if (args.functionName === 'rootAnchorUID') return ROOT_ANCHOR
      if (args.functionName === 'resolvePath') return TRANSPORTS_ROOT
      if (args.functionName === 'getAttestation') {
        // Per-UID dispatch: the gates read BOTH the hardlink target and any
        // reused concrete file-ANCHOR.
        const [queried] = (args.args ?? []) as [Hex]
        if (queried === TRANSPORT) {
          return {
            uid: queried,
            schema: SCHEMAS.anchor,
            refUID: TRANSPORTS_ROOT,
            data: encodeAbiParameters(
              [{ type: 'string' }, { type: 'bytes32' }],
              ['ipfs', ZERO_UID],
            ),
          }
        }
        if (queried === EXISTING_ANCHOR) {
          return {
            uid: queried,
            schema: opts.anchorSchema ?? SCHEMAS.anchor,
            refUID: opts.anchorParent ?? PARENT, // the slot's parent
            data: encodeAbiParameters(
              [{ type: 'string' }, { type: 'bytes32' }],
              [opts.anchorName ?? 'readme.md', SCHEMAS.data],
            ),
          }
        }
        return {
          attester: opts.hardlinkAuthor ?? ACCOUNT,
          schema: opts.hardlinkSchema ?? SCHEMAS.data,
        }
      }
      // The hardlink gate's readability proof (active-mirror scan).
      if (args.functionName === 'getReferencingBySchemaAndAttesterCount') {
        return opts.hardlinkMirrorCount ?? 1n
      }
      if (args.functionName === 'getReferencingBySchemaAndAttester') {
        return (opts.hardlinkMirrorCount ?? 1n) > 0n ? [uid(0x3141)] : []
      }
      throw new Error(`mock: unexpected readContract ${args.functionName}`)
    },
    async waitForTransactionReceipt({ hash }) {
      // The tx hash encodes its 1-based call index (`0x..0N`); honor a configured
      // receipt-wait throw for that layer (the tx WAS sent — a hash exists).
      if (opts.receiptThrowOnCall !== undefined) {
        const callOfHash = Number.parseInt(hash, 16)
        if (callOfHash === opts.receiptThrowOnCall) {
          throw new Error(`mock: receipt wait failed for ${hash} (timeout/RPC)`)
        }
      }
      const r = receipts.get(hash)
      if (!r) throw new Error(`mock: no receipt for ${hash}`)
      return r
    },
  }

  const ctx: SubmitContext = {
    walletClient,
    publicClient,
    easAddress: EAS,
    indexerAddress: '0x0000000000000000000000000000000000001dc5' as Address,
    account: ACCOUNT,
  }
  return {
    ctx,
    sent,
    get callCount() {
      return callIndex
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('submitWriteTier1 — full fresh-file graph', () => {
  it('sends exactly one multiAttest per DAG layer, in layer order (1 → 2 → 3)', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    const result = await submitWriteTier1(plan, ctx)

    // 3 layers present in the full graph.
    expect(sent).toHaveLength(3)
    expect(result.layerTxHashes).toHaveLength(3)
    expect(result.layers.map((l) => l.layer)).toEqual([1, 2, 3])

    // L1 = DATA + file-ANCHOR (atomic slot mint, r3741399511), L3 = 4 PINs
    // (placement + 3 binding), L2 = the rest.
    expect(sent[0].entries).toHaveLength(2) // DATA + file-ANCHOR
    expect(sent[2].entries).toHaveLength(4) // PINs
    const total = sent.reduce((n, s) => n + s.entries.length, 0)
    expect(total).toBe(13)
  })

  it('forwards account + EAS address + zeroed recipient/value/expiry on every entry', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    await submitWriteTier1(plan, ctx)

    for (const layer of sent) {
      expect(layer.args.address).toBe(EAS)
      expect((layer.args as { account?: unknown }).account).toBe(ACCOUNT)
      expect(layer.args.value).toBe(0n)
      for (const r of layer.args.args[0]) {
        for (const d of r.data) {
          expect(d.recipient).toBe('0x0000000000000000000000000000000000000000')
          expect(d.expirationTime).toBe(0n)
          expect(d.value).toBe(0n)
        }
      }
    }
  })

  it('resolves symbolic refUIDs from prior-layer mined UIDs (L2 MIRROR/anchors → DATA)', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    // DATA is the single L1 entry → global index 0 → 0xD000.
    const { ctx, sent } = makeMockChain()
    const result = await submitWriteTier1(plan, ctx)

    const dataUID = result.dataUID
    expect(dataUID).toBe(uid(0xd000))

    // Every L2 entry whose graph refUID was symbolic-DATA must now carry the real
    // DATA UID. PROPERTYs ref 0x0. The file-ANCHOR rides in L1 with DATA now
    // (r3741399511) and points at the concrete PARENT.
    const l1refs = sent[0].entries.map((e) => e.refUID)
    expect(l1refs).toContain(PARENT) // the file-ANCHOR, atomically with DATA
    const l2 = sent[1].entries
    const refUIDs = l2.map((e) => e.refUID)
    // MIRROR + 3 key-anchors point at DATA.
    expect(refUIDs.filter((r) => r === dataUID).length).toBe(4)
    // PROPERTYs point at 0x0.
    expect(refUIDs.filter((r) => r === ZERO_UID).length).toBe(3)
    expect(refUIDs).not.toContain(PARENT) // no anchor left in L2
  })

  it('re-encodes PIN `definition` between layers with the mined anchor UID', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    const result = await submitWriteTier1(plan, ctx)

    // The placement PIN's definition must equal the mined file-ANCHOR UID, and its
    // refUID must equal the mined DATA UID.
    const fileAnchorUID = result.uids.get('fileAnchor')!
    const dataUID = result.dataUID!
    expect(fileAnchorUID).toBeDefined()

    const l3 = sent[2].entries
    // Find the placement PIN: refUID === DATA.
    const placement = l3.find((e) => e.refUID === dataUID)
    expect(placement).toBeDefined()
    const [decodedDefinition] = pinEnc.decodeData(placement!.data) as [Hex]
    expect(decodedDefinition).toBe(fileAnchorUID)
    // And it is NOT the placeholder zero anymore.
    expect(decodedDefinition).not.toBe(ZERO_UID)

    // Each binding PIN's definition === its mined key-anchor UID.
    for (const key of ['contentType', 'contentHash', 'size'] as const) {
      const propUID = result.uids.get(`prop:${key}`)!
      const anchorUID = result.uids.get(`anchor:${key}`)!
      const bindingPin = l3.find((e) => e.refUID === propUID)
      expect(bindingPin).toBeDefined()
      const [def] = pinEnc.decodeData(bindingPin!.data) as [Hex]
      expect(def).toBe(anchorUID)
    }
  })

  it('returns all created UIDs keyed by ref, plus DATA + placement-PIN UIDs', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx } = makeMockChain()
    const result = await submitWriteTier1(plan, ctx)

    // 13 distinct refs minted.
    expect(result.uids.size).toBe(13)
    expect(result.dataUID).toBe(result.uids.get('DATA'))
    expect(result.placementPinUID).toBe(result.uids.get('placementPin'))
    // Deterministic global order: DATA first (0xD000), placement PIN is last entry
    // of the last layer (global index 12).
    expect(result.dataUID).toBe(uid(0xd000))
    expect(result.placementPinUID).toBe(uid(0xd000 + 12))
  })

  it('groups each layer multiAttest by schema (one request per distinct schema)', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    await submitWriteTier1(plan, ctx)

    // L2 has anchors (4: file + 3 keys), property (3), mirror (1) → 3 distinct
    // schemas → 3 requests.
    const l2Requests = sent[1].args.args[0]
    const schemas = new Set(l2Requests.map((r) => r.schema))
    expect(schemas.size).toBe(l2Requests.length) // no duplicate schema across requests
    expect(schemas).toContain(SCHEMAS.anchor)
    expect(schemas).toContain(SCHEMAS.property)
    expect(schemas).toContain(SCHEMAS.mirror)

    // L3 is all PINs → a single request under the pin schema.
    const l3Requests = sent[2].args.args[0]
    expect(l3Requests).toHaveLength(1)
    expect(l3Requests[0].schema).toBe(SCHEMAS.pin)
    expect(l3Requests[0].data).toHaveLength(4)
  })

  it('fires onLayer once per layer with the minted refs', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const events: number[] = []
    const { ctx } = makeMockChain()
    await submitWriteTier1(plan, { ...ctx, onLayer: (e) => events.push(e.minted.length) })
    expect(events).toEqual([2, 7, 4]) // L1=2 (DATA + fileAnchor), L2=7, L3=4
  })
})

describe('submitWriteTier1 — receipt UID extraction', () => {
  it('filters Attested events to the EAS contract (ignores foreign emitters)', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx } = makeMockChain({ extraNoiseLog: true })
    // Should not throw despite an extra foreign Attested log per receipt.
    const result = await submitWriteTier1(plan, ctx)
    expect(result.uids.size).toBe(13)
  })

  it('a receipt whose Attested logs cannot be extracted surfaces WriteUidsUnknownError, never "unsent" or "reverted" (r3740563979/r3740820584)', async () => {
    // The layer MINED (receipt status success) — only log extraction failed
    // (incomplete RPC logs / drift). A bare throw read as "unsent"; encoding it
    // as WriteRevertedError{mined:true} claimed the refs did NOT mint (that
    // class's contract) when every one of them DID — recovery reading the
    // top-level fields would resend and duplicate the layer. The DISTINCT
    // class carries the mined txHash + mintedRefs + the prior landed map; the
    // extraction failure (count mismatch here) is the cause.
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx } = makeMockChain({ dropLastLog: true })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(WriteUidsUnknownError)
    expect(err).not.toBeInstanceOf(WriteRevertedError)
    const w = err as WriteUidsUnknownError
    expect(w.txHash).toMatch(/^0x/)
    expect(w.mintedRefs.length).toBeGreaterThan(0)
    expect(String(w.message)).toMatch(/EXIST on-chain with unknown UIDs/)
    expect(String(w.message)).toMatch(/Do NOT resend/)
    expect(String(w.cause)).toMatch(/does not match the submitted multiAttest/)
  })
})

describe('submitWriteTier1 — hardlink plan', () => {
  it('REFUSES a foreign-authored hardlink BEFORE any layer broadcasts (r3741157003)', async () => {
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const { ctx, sent } = makeMockChain({
      hardlinkAuthor: '0x000000000000000000000000000000000000beef' as Address,
    })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/authored by 0x0+beef/i)
    expect(String((err as Error).message)).toMatch(/ForeignDataUID/) // Solidity parity pointer
    expect(sent).toHaveLength(0) // nothing broadcast — the gate runs first
  })

  it('REFUSES a self-authored NON-DATA target — schema gate (r3741189815)', async () => {
    // EdgeResolver indexes the PIN under the TARGET's schema; file resolution
    // reads the DATA slot — a confirmed receipt for an invisible file.
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const { ctx, sent } = makeMockChain({ hardlinkSchema: SCHEMAS.anchor })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/not a DATA attestation/)
    expect(String((err as Error).message)).toMatch(/NotDataUID/) // Solidity parity pointer
    expect(sent).toHaveLength(0)
  })

  it('FAILS CLOSED on a hardlink plan without the dataSchemaUID stamp', async () => {
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const stripped = { ...plan, dataSchemaUID: undefined } as typeof plan
    const { ctx, sent } = makeMockChain()
    const err = await submitWriteTier1(stripped, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/dataSchemaUID stamp/)
    expect(sent).toHaveLength(0)
  })

  it('FAILS CLOSED on a hand-built hardlink plan with a SYMBOLIC placement target (r3741235140)', async () => {
    // A crafted plan could mint a non-DATA in an earlier layer, resolve the PIN
    // to it symbolically, and skip every check — the old defensive return was
    // fail-OPEN.
    const crafted = { ...buildFileWriteGraph(bytesInput), hardlink: true }
    const { ctx, sent } = makeMockChain()
    const err = await submitWriteTier1(crafted, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/CONCRETE placement-PIN refUID/)
    expect(sent).toHaveLength(0)
  })

  it('REFUSES a self-authored DATA with NO active mirror — unreadable placement (r3741235144)', async () => {
    // A bare DATA minted via the raw EAS verbs passes authorship + schema, but
    // the hardlink builder emits no retrieval metadata — the placement would
    // confirm and every read() would fail AllMirrorsFailed.
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const { ctx, sent } = makeMockChain({ hardlinkMirrorCount: 0n })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/NO active mirror/)
    expect(String((err as Error).message)).toMatch(/efs\.mirrors\.add/)
    expect(sent).toHaveLength(0)
  })

  it('FAILS CLOSED on a hardlink submission without ctx.indexerAddress', async () => {
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const { ctx, sent } = makeMockChain()
    const bare = { ...ctx, indexerAddress: undefined } as SubmitContext
    const err = await submitWriteTier1(plan, bare).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/indexerAddress/)
    expect(sent).toHaveLength(0)
  })

  it('REFUSES a reused concrete anchor that is NOT an ANCHOR (r3741288472)', async () => {
    // An arbitrary existingFileAnchorUID skips the anchor mint — if it is a
    // PROPERTY/DATA/nonexistent UID, the placement confirms but path
    // resolution can never discover it.
    const plan = buildFileWriteGraph({
      ...bytesInput,
      existingFileAnchorUID: EXISTING_ANCHOR,
    })
    const { ctx, sent } = makeMockChain({ anchorSchema: SCHEMAS.property })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/not an ANCHOR attestation/)
    expect(sent).toHaveLength(0)
  })

  it('a GENUINE reused anchor passes the concrete-anchor gate and submits', async () => {
    const plan = buildFileWriteGraph({
      ...bytesInput,
      existingFileAnchorUID: EXISTING_ANCHOR,
    })
    const { ctx, sent } = makeMockChain()
    await submitWriteTier1(plan, ctx)
    expect(sent.length).toBeGreaterThan(0) // the overwrite write went through
  })

  it('REFUSES a reused anchor from a DIFFERENT slot — wrong parent (r3741335345)', async () => {
    const plan = buildFileWriteGraph({ ...bytesInput, existingFileAnchorUID: EXISTING_ANCHOR })
    const { ctx, sent } = makeMockChain({ anchorParent: uid(0x999) })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/DIFFERENT slot/)
    expect(sent).toHaveLength(0)
  })

  it('REFUSES a reused anchor with a DIFFERENT name', async () => {
    const plan = buildFileWriteGraph({ ...bytesInput, existingFileAnchorUID: EXISTING_ANCHOR })
    const { ctx, sent } = makeMockChain({ anchorName: 'other.md' })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/DIFFERENT slot/)
    expect(sent).toHaveLength(0)
  })

  it('asserts the LIVE chain BEFORE any gate read (r3741637985)', async () => {
    // A drifted provider must not serve the gates another chain's state — the
    // assertion fires first, and no validation read ever happens.
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const { ctx, sent } = makeMockChain()
    let gateReads = 0
    const drifted = {
      ...ctx,
      publicClient: {
        ...ctx.publicClient,
        async readContract(a: unknown) {
          gateReads += 1
          return (
            ctx.publicClient as unknown as { readContract: (x: unknown) => Promise<unknown> }
          ).readContract(a)
        },
      },
      assertChain: async () => {
        throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
      },
    } as SubmitContext
    const err = await submitWriteTier1(plan, drifted).catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
    expect(gateReads).toBe(0) // no validation read against the drifted provider
    expect(sent).toHaveLength(0)
  })

  it('REFUSES a non-ANCHOR mirror transportDefinition BEFORE layer 1 (r3741671356)', async () => {
    // MirrorResolver only rejects at the layer-2 MIRROR — by then DATA +
    // file-ANCHOR have mined (a paid partial graph).
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    const bad = {
      ...ctx,
      publicClient: {
        ...ctx.publicClient,
        async readContract(a: { functionName: string }) {
          if (a.functionName === 'getAttestation') return { schema: SCHEMAS.data } // not an ANCHOR
          return (
            ctx.publicClient as unknown as { readContract: (x: unknown) => Promise<unknown> }
          ).readContract(a)
        },
      },
    } as SubmitContext
    const err = await submitWriteTier1(plan, bad).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/is not an ANCHOR attestation/)
    expect(sent).toHaveLength(0)
  })

  it('REFUSES a transport anchor outside /transports/', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    const orphan = {
      ...ctx,
      publicClient: {
        ...ctx.publicClient,
        async readContract(a: { functionName: string }) {
          // A real ANCHOR whose parent chain never reaches /transports.
          if (a.functionName === 'getAttestation') {
            return { schema: SCHEMAS.anchor, refUID: ZERO_UID }
          }
          return (
            ctx.publicClient as unknown as { readContract: (x: unknown) => Promise<unknown> }
          ).readContract(a)
        },
      },
    } as SubmitContext
    const err = await submitWriteTier1(plan, orphan).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/not a descendant of \/transports\//)
    expect(sent).toHaveLength(0)
  })

  it('FAILS CLOSED when the context cannot run the authorship read', async () => {
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    const { ctx, sent } = makeMockChain()
    const bare = {
      ...ctx,
      publicClient: { waitForTransactionReceipt: ctx.publicClient.waitForTransactionReceipt },
    } as SubmitContext
    const err = await submitWriteTier1(plan, bare).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/readContract/)
    expect(sent).toHaveLength(0)
  })

  it('threads the file-ANCHOR symbol and points the PIN at the pre-existing DATA', async () => {
    const plan = buildFileWriteGraph({
      ...hardlinkBase,
      content: { kind: 'hardlink', dataUID: EXISTING_DATA },
    })
    expect(plan.hardlink).toBe(true)

    const { ctx, sent } = makeMockChain()
    const result = await submitWriteTier1(plan, ctx)

    // file-ANCHOR (L2) and placement PIN (L3) → two layer txs.
    expect(sent).toHaveLength(2)
    // No fresh DATA minted (reused pre-existing).
    expect(result.dataUID).toBeUndefined()

    // The PIN refUID is the PRE-EXISTING DATA, and its definition is the mined
    // file-ANCHOR.
    const fileAnchorUID = result.uids.get('fileAnchor')!
    const pinEntry = sent[1].entries[0]
    expect(pinEntry.refUID).toBe(EXISTING_DATA)
    const [def] = pinEnc.decodeData(pinEntry.data) as [Hex]
    expect(def).toBe(fileAnchorUID)
    expect(result.placementPinUID).toBe(result.uids.get('placementPin'))
  })
})

describe('submitWriteTier1 — single-layer plan is one tx (one signature)', () => {
  it('collapses to a single multiAttest when all attestations share a layer', async () => {
    // Construct a synthetic single-layer plan: two independent L2 attestations with
    // no symbolic refs (concrete refUIDs only).
    const plan = {
      hardlink: false,
      attestations: [
        {
          ref: 'a',
          layer: 2 as const,
          kind: 'ANCHOR' as const,
          schema: SCHEMAS.anchor,
          data: new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor).encodeData(['x', ZERO_UID]),
          revocable: false,
          refUID: PARENT,
          dataRefs: [],
        },
        {
          ref: 'b',
          layer: 2 as const,
          kind: 'PIN' as const,
          schema: SCHEMAS.pin,
          data: pinEnc.encodeData([EXISTING_DATA]),
          revocable: true,
          refUID: EXISTING_DATA,
          dataRefs: [],
        },
      ],
    }

    const { ctx, sent } = makeMockChain()
    // No placement PIN in this synthetic plan → submitter throws on the final check,
    // but only AFTER sending the single layer. Assert the single-tx property first.
    await expect(submitWriteTier1(plan, ctx)).rejects.toThrow(/no placement PIN/)
    expect(sent).toHaveLength(1)
    expect(sent[0].entries).toHaveLength(2)
  })
})

describe('submitWriteTier1 — per-layer wrong-chain guard', () => {
  it('re-runs assertChain before EACH layer send; a mid-write switch folds into the no-tx partial error', async () => {
    const plan = buildFileWriteGraph(bytesInput) // 3 dependency layers
    const { ctx, sent } = makeMockChain()
    let checks = 0
    // Two checks run per layer (before the send, before the receipt wait). Layer 1 completes
    // (send-check 1, wait-check 2); the wallet then switches networks, so layer 2's PRE-SEND
    // check (3) fails closed — the dependent layer never broadcasts to the new chain.
    const assertChain = async () => {
      checks += 1
      // +1 vs. the old counts: the PRE-GATE assertion (r3741637985) fires first
      // on any gate-stamped plan (this one carries mirrorTransportUIDs).
      if (checks >= 4) throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
    }
    const err = await submitWriteTier1(plan, { ...ctx, assertChain }).catch((e) => e)
    // The pre-send wrong-chain drift is a NO-TX failure for layer 2: it folds into
    // WriteNotSentError (PartialBatchFailure) carrying the landed-UID map + the WrongChain
    // CAUSE — not a bare WrongChain that strips the partial-write recovery context.
    expect(err).toBeInstanceOf(WriteNotSentError)
    const we = err as WriteNotSentError
    expect(we.layer).toBe(2)
    expect(we.code).toBe('PartialBatchFailure')
    expect(we.landed.get('DATA')).toBe(uid(0xd000)) // layer 1 already landed, preserved for recovery
    expect((we.cause as { code?: string })?.code).toBe('WrongChain')
    expect(checks).toBe(4)
    expect(sent).toHaveLength(1) // only layer 1 broadcast; the dependent layer 2 did NOT
  })

  it('re-checks the chain before the receipt wait; a post-send switch is outcome-unknown (mined:false) with the txHash', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    let checks = 0
    // Layer 1's send-check (1) passes and the tx broadcasts; the provider then drifts, so the
    // PRE-WAIT check (2) fails closed. Inside the receipt-wait try, the drift surfaces as the
    // honest "may still mine" outcome carrying the in-flight txHash — never a false revert —
    // so recovery can re-bind and check the hash.
    const assertChain = async () => {
      checks += 1
      if (checks >= 3) throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
    }
    const err = await submitWriteTier1(plan, { ...ctx, assertChain }).catch((e) => e)
    expect(err).toBeInstanceOf(WriteRevertedError)
    const we = err as WriteRevertedError
    expect(we.mined).toBe(false) // outcome unknown — the tx may still mine on the deployment chain
    expect(we.txHash).toBe(uid(1)) // layer 1's in-flight hash preserved for recovery
    expect(sent).toHaveLength(1) // layer 1 WAS broadcast
  })

  it('runs assertChain before each layer send AND each receipt wait (2 per layer)', async () => {
    const plan = buildFileWriteGraph(bytesInput) // 3 layers
    const { ctx, sent } = makeMockChain()
    let checks = 0
    await submitWriteTier1(plan, {
      ...ctx,
      assertChain: async () => {
        checks += 1
      },
    })
    expect(sent).toHaveLength(3)
    expect(checks).toBe(7) // 1 pre-gate + (send + receipt wait) per layer
  })
})

describe('submitWriteTier1 — progress-hook isolation', () => {
  it('a throwing onLayer callback does NOT abort the write (all layers still sent)', async () => {
    const plan = buildFileWriteGraph(bytesInput) // 3 layers
    const { ctx, sent } = makeMockChain()
    let fired = 0
    // A reporting-callback bug throwing AFTER a layer mined must not interrupt the remaining
    // irreversible layers — that would manufacture a partial write from UI code.
    const onLayer = () => {
      fired += 1
      throw new Error('progress callback blew up')
    }
    // Resolves (does not reject) and sends every layer despite the throwing hook.
    await expect(submitWriteTier1(plan, { ...ctx, onLayer })).resolves.toBeDefined()
    expect(sent).toHaveLength(3) // all layers broadcast
    expect(fired).toBe(3) // the hook fired (and threw) on each layer, swallowed each time
  })
})

describe('submitWriteTier1 — mid-write cancellation', () => {
  it('a mid-write abort (after a layer landed) folds into the no-tx partial error', async () => {
    const plan = buildFileWriteGraph(bytesInput) // 3 layers
    const controller = new AbortController()
    const { ctx, sent } = makeMockChain()
    // Abort right after layer 1's multiAttest mines — the next layer's pre-send check bails.
    let n = 0
    const origWrite = ctx.walletClient.writeContract
    const walletClient = {
      ...ctx.walletClient,
      writeContract: async (a: Parameters<typeof origWrite>[0]) => {
        const h = await origWrite(a)
        if (++n === 1)
          controller.abort(Object.assign(new Error('user cancelled'), { name: 'AbortError' }))
        return h
      },
    }
    const err = await submitWriteTier1(plan, {
      ...ctx,
      walletClient,
      signal: controller.signal,
    }).catch((e) => e)
    // Already partial (layer 1 landed) → WriteNotSentError carrying the landed map + the
    // AbortError cause, NOT a bare AbortError that strips recovery context.
    expect(err).toBeInstanceOf(WriteNotSentError)
    const we = err as WriteNotSentError
    expect(we.layer).toBe(2)
    expect(we.landed.get('DATA')).toBe(uid(0xd000)) // layer 1 preserved
    expect((we.cause as { name?: string })?.name).toBe('AbortError')
    expect(sent).toHaveLength(1)
  })

  it('an abort before the FIRST layer escapes as a raw AbortError (nothing landed)', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx, sent } = makeMockChain()
    const err = await submitWriteTier1(plan, {
      ...ctx,
      signal: AbortSignal.abort(),
    }).catch((e) => e)
    expect(err).not.toBeInstanceOf(WriteNotSentError) // no partial write to describe
    expect((err as Error).name).toBe('AbortError')
    expect(sent).toHaveLength(0)
  })
})

describe('submitWriteTier1 — partial-write boundary: three distinct failure modes', () => {
  it('writeContract throw → WriteNotSentError (no tx sent, safe retry), prior layers preserved', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    // writeContract THROWS on the SECOND call (layer 2). Layer 1 (DATA) already mined.
    const { ctx, sent } = makeMockChain({ revertOnCall: 2 })

    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    // (a) NO-TX-SENT: the no-tx error, never WriteRevertedError.
    expect(err).toBeInstanceOf(WriteNotSentError)
    expect(err).not.toBeInstanceOf(WriteRevertedError)
    const we = err as WriteNotSentError
    expect(we.layer).toBe(2)
    expect(we.code).toBe('PartialBatchFailure')
    // No txHash field — nothing is in flight.
    expect((we as unknown as { txHash?: unknown }).txHash).toBeUndefined()
    // Layer-1 DATA + file-ANCHOR landed before the failure (r3741399511: the
    // anchor shares DATA's layer now — prior-layer refs preserved).
    expect(we.landed.size).toBe(2)
    expect(we.landed.get('DATA')).toBe(uid(0xd000))
    expect(we.landed.has('fileAnchor')).toBe(true)
    // The failed refs are the layer-2 refs (7 of them — the anchor moved to L1).
    expect(we.failedRefs).toHaveLength(7)
    expect(we.failedRefs).toContain('mirror:0')
    // Only one layer tx was sent successfully before the failure.
    expect(sent).toHaveLength(1)
    // r3740820587: layer 1 ALREADY LANDED, so the message must NOT bless a
    // whole-write retry (fs.write does not resume — a retry re-mints layer 1).
    expect(String(we.message)).not.toMatch(/retry is safe/)
    expect(String(we.message)).toMatch(/ALREADY LANDED and fs.write does not resume/)
  })

  it('code-less transport loss at send → WriteSendUnknownError (may still mine), never "not sent" (r3740924421)', async () => {
    // The RPC may have accepted the tx before the connection dropped — no
    // response, no hash. WriteNotSentError's "nothing was broadcast" contract
    // must not be asserted: a retry could duplicate the layer.
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx } = makeMockChain({ transportErrorOnCall: 2 })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    expect(err).toBeInstanceOf(WriteSendUnknownError)
    expect(err).not.toBeInstanceOf(WriteNotSentError)
    const we = err as WriteSendUnknownError
    expect(we.layer).toBe(2)
    expect(we.landed.get('DATA')).toBe(uid(0xd000)) // prior layer preserved
    expect(we.refs).toContain('mirror:0') // a layer-2 ref (the anchor now lands in L1)
    expect(String(we.message)).toMatch(/UNKNOWN and it MAY still mine/)
  })

  it('receipt-wait throw after a hash → WriteRevertedError(mined:false) carrying the in-flight txHash', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    // The tx for layer 2 WAS sent (a hash exists), but the receipt wait throws.
    const { ctx, sent } = makeMockChain({ receiptThrowOnCall: 2 })

    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    // (b) TX-SENT / RECEIPT-UNKNOWN.
    expect(err).toBeInstanceOf(WriteRevertedError)
    const we = err as WriteRevertedError
    expect(we.layer).toBe(2)
    // The tx may still mine — outcome unknown.
    expect(we.mined).toBe(false)
    // Carries the in-flight tx hash (call 2 → 0x..02).
    expect(we.txHash).toBe(uid(2))
    // Prior-layer (DATA + file-ANCHOR) refs preserved.
    expect(we.landed.size).toBe(2)
    expect(we.landed.get('DATA')).toBe(uid(0xd000))
    expect(we.failedRefs).toContain('mirror:0')
    // The layer-2 tx WAS broadcast before the receipt wait failed.
    expect(sent).toHaveLength(2)
    expect(String(we.message)).toMatch(/may still mine/)
  })

  it('receipt status:reverted → WriteRevertedError(mined:true) carrying the txHash', async () => {
    const plan = buildFileWriteGraph(bytesInput)
    const { ctx } = makeMockChain({ receiptRevertOnCall: 3 })
    const err = await submitWriteTier1(plan, ctx).catch((e) => e)
    // (c) MINED-REVERTED.
    expect(err).toBeInstanceOf(WriteRevertedError)
    const we = err as WriteRevertedError
    expect(we.layer).toBe(3)
    expect(we.mined).toBe(true)
    // Carries the mined tx hash (call 3 → 0x..03).
    expect(we.txHash).toBe(uid(3))
    // Layers 1 + 2 landed (2 + 7 = 9 refs) — prior-layer refs preserved.
    expect(we.landed.size).toBe(9)
    expect(String(we.message)).toMatch(/mined and reverted/)
  })
})
