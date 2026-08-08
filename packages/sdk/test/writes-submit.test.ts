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
const CONTENT_HASH = uid(0x300)
const EXISTING_DATA = uid(0x400)
const ACCOUNT: Address = '0x00000000000000000000000000000000000acc01'

const baseInput = {
  path: '/docs/readme.md',
  mirrors: [{ uri: 'ipfs://QmExample', transportDefinition: TRANSPORT }] as const,
  contentType: 'text/markdown',
  contentHash: CONTENT_HASH,
  size: 1234n,
  schemas: SCHEMAS,
  parentAnchorUID: PARENT,
  fileName: 'readme.md',
} as const

const bytesInput = {
  ...baseInput,
  content: { kind: 'bytes' as const, bytes: new Uint8Array([1, 2, 3]) },
}

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
  /** Layer (1-based call index) at which `writeContract` should throw. */
  revertOnCall?: number
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
        throw new Error(`mock revert at call ${thisCall} (execution reverted: NotRevocable)`)
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

  const ctx: SubmitContext = { walletClient, publicClient, easAddress: EAS, account: ACCOUNT }
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

    // L1 = just DATA (1 entry), L3 = 4 PINs (placement + 3 binding), L2 = the rest.
    expect(sent[0].entries).toHaveLength(1) // DATA
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
    // DATA UID. The file-ANCHOR refs the concrete PARENT (not DATA). PROPERTYs ref 0x0.
    const l2 = sent[1].entries
    const refUIDs = l2.map((e) => e.refUID)
    // MIRROR + 3 key-anchors point at DATA.
    expect(refUIDs.filter((r) => r === dataUID).length).toBe(4)
    // file-ANCHOR points at the concrete parent.
    expect(refUIDs).toContain(PARENT)
    // PROPERTYs point at 0x0.
    expect(refUIDs.filter((r) => r === ZERO_UID).length).toBe(3)
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
    expect(events).toEqual([1, 8, 4]) // L1=1, L2=8, L3=4
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
  it('threads the file-ANCHOR symbol and points the PIN at the pre-existing DATA', async () => {
    const plan = buildFileWriteGraph({
      ...baseInput,
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
      if (checks >= 3) throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
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
    expect(checks).toBe(3)
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
      if (checks >= 2) throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
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
    expect(checks).toBe(6) // before the send + before the receipt wait, per layer
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
    // Layer-1 DATA landed before the failure (prior-layer refs preserved).
    expect(we.landed.size).toBe(1)
    expect(we.landed.get('DATA')).toBe(uid(0xd000))
    // The failed refs are the layer-2 refs (8 of them).
    expect(we.failedRefs).toHaveLength(8)
    expect(we.failedRefs).toContain('fileAnchor')
    // Only one layer tx was sent successfully before the failure.
    expect(sent).toHaveLength(1)
    // r3740820587: layer 1 ALREADY LANDED, so the message must NOT bless a
    // whole-write retry (fs.write does not resume — a retry re-mints layer 1).
    expect(String(we.message)).not.toMatch(/retry is safe/)
    expect(String(we.message)).toMatch(/ALREADY LANDED and fs.write does not resume/)
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
    // Prior-layer (DATA) refs preserved.
    expect(we.landed.size).toBe(1)
    expect(we.landed.get('DATA')).toBe(uid(0xd000))
    expect(we.failedRefs).toContain('fileAnchor')
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
    // Layers 1 + 2 landed (1 + 8 = 9 refs) — prior-layer refs preserved.
    expect(we.landed.size).toBe(9)
    expect(String(we.message)).toMatch(/mined and reverted/)
  })
})
