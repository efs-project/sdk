/**
 * Standalone edge/value write primitives (TAG / PROPERTY-triple / PIN) — the pure
 * plan builders, the shared edge submit (mock chain), and the namespace verbs
 * (`makeTagsNs` / `makePropsNs` / `makePinsNs`) over mock clients. No live chain.
 *
 * Verifies each verb against the spec: `tags.add` emits a TAG with the right
 * definition/target/weight and submits; `props.set` emits the triple threaded
 * correctly; `pins.place` emits the placement PIN; `remove`/`unplace` revoke the
 * right UID; the read verbs resolve correctly.
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
import { type EdgeSubmitContext, submitEdgePlan } from '../src/writes/edge-submit.js'
import {
  DEFAULT_TAG_WEIGHT,
  EDGE_REF,
  buildPlacementPinPlan,
  buildPropertyPlan,
  buildTagPlan,
} from '../src/writes/edge.js'
import { makePinsNs } from '../src/writes/pins.js'
import { makePropsNs } from '../src/writes/props.js'
import { makeTagsNs, resolveTagDefinition } from '../src/writes/tags.js'

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
const EDGE = addr(0xed6e)
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
    edgeResolver: EDGE,
    mirrorResolver: addr(0x203),
    listResolver: addr(0x204),
    listEntryResolver: addr(0x205),
    listReader: addr(0x206),
    aliasResolver: addr(0x207),
    systemAccount: addr(0x208),
  },
}

const tagEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.tag)
const anchorEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
const propEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.property)
const pinEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)

// ── Pure builders ───────────────────────────────────────────────────────────────

describe('buildTagPlan', () => {
  const TARGET = uid(0x500)
  const DEF = uid(0x600)

  it('emits one TAG (definition/target/weight) — single-layer, one signature', () => {
    const plan = buildTagPlan(SCHEMAS, TARGET, DEF, 7n)
    expect(plan.attestations).toHaveLength(1)
    const tag = plan.attestations[0]
    expect(tag?.kind).toBe('TAG')
    expect(tag?.layer).toBe(1)
    expect(tag?.schema).toBe(SCHEMAS.tag)
    expect(tag?.revocable).toBe(true) // EdgeResolver requires revocable
    expect(tag?.refUID).toBe(TARGET) // target rides in refUID
    expect(tag?.dataRefs).toEqual([])
    // data = (definition, weight)
    expect(tag?.data).toBe(tagEnc.encodeData([DEF, 7n]))
  })

  it('defaults weight to 1 (ADR-0041 convention)', () => {
    const plan = buildTagPlan(SCHEMAS, TARGET, DEF)
    expect(plan.attestations[0]?.data).toBe(tagEnc.encodeData([DEF, DEFAULT_TAG_WEIGHT]))
  })
})

describe('buildPropertyPlan', () => {
  const DATA = uid(0x700)

  it('emits the key-ANCHOR + PROPERTY + binding-PIN triple, threaded correctly', () => {
    const plan = buildPropertyPlan(SCHEMAS, DATA, 'author', 'alice')
    expect(plan.attestations).toHaveLength(3)
    const byRef = Object.fromEntries(plan.attestations.map((a) => [a.ref, a]))

    const keyAnchor = byRef[EDGE_REF.KEY_ANCHOR]
    expect(keyAnchor?.kind).toBe('ANCHOR')
    expect(keyAnchor?.layer).toBe(1)
    expect(keyAnchor?.revocable).toBe(false)
    expect(keyAnchor?.refUID).toBe(DATA) // bound under the DATA
    // forSchema MUST be the PROPERTY schema UID (the load-bearing keying)
    expect(keyAnchor?.data).toBe(anchorEnc.encodeData(['author', SCHEMAS.property]))

    const property = byRef[EDGE_REF.PROPERTY]
    expect(property?.kind).toBe('PROPERTY')
    expect(property?.layer).toBe(1)
    expect(property?.revocable).toBe(false)
    expect(property?.refUID).toBe(uid(0)) // PROPERTY refUID must be 0
    expect(property?.data).toBe(propEnc.encodeData(['alice']))

    const pin = byRef[EDGE_REF.BINDING_PIN]
    expect(pin?.kind).toBe('PIN')
    expect(pin?.layer).toBe(2) // depends on the fresh L1 siblings
    expect(pin?.revocable).toBe(true)
    expect(pin?.refUID).toEqual({ ref: EDGE_REF.PROPERTY }) // refUID = PROPERTY (symbolic)
    expect(pin?.dataRefs).toEqual([{ field: 'definition', ref: { ref: EDGE_REF.KEY_ANCHOR } }])
  })

  it('with an existing key anchor (Bug-2): emits ONLY PROPERTY + binding-PIN (no key-ANCHOR)', () => {
    const EXISTING = uid(0x7aa)
    const plan = buildPropertyPlan(SCHEMAS, DATA, 'author', 'bob', EXISTING)
    // No fresh key-ANCHOR — the permanent existing one is reused.
    expect(plan.attestations).toHaveLength(2)
    const byRef = Object.fromEntries(plan.attestations.map((a) => [a.ref, a]))
    expect(byRef[EDGE_REF.KEY_ANCHOR]).toBeUndefined()
    // Fresh PROPERTY (new value).
    const property = byRef[EDGE_REF.PROPERTY]
    expect(property?.kind).toBe('PROPERTY')
    expect(property?.data).toBe(propEnc.encodeData(['bob']))
    // binding-PIN: definition = the CONCRETE existing key-anchor (encoded directly, no
    // symbolic thread); refUID = the fresh PROPERTY.
    const pin = byRef[EDGE_REF.BINDING_PIN]
    expect(pin?.kind).toBe('PIN')
    expect(pin?.revocable).toBe(true)
    expect(pin?.refUID).toEqual({ ref: EDGE_REF.PROPERTY })
    expect(pin?.dataRefs).toEqual([]) // concrete definition — nothing to thread
    expect(pin?.data).toBe(pinEnc.encodeData([EXISTING]))
  })
})

describe('buildPlacementPinPlan', () => {
  const ANCHOR = uid(0x800)
  const DATA = uid(0x900)

  it('emits one placement PIN (definition = anchor, refUID = DATA) — one signature', () => {
    const plan = buildPlacementPinPlan(SCHEMAS, ANCHOR, DATA)
    expect(plan.attestations).toHaveLength(1)
    const pin = plan.attestations[0]
    expect(pin?.kind).toBe('PIN')
    expect(pin?.layer).toBe(1)
    expect(pin?.schema).toBe(SCHEMAS.pin)
    expect(pin?.revocable).toBe(true)
    expect(pin?.refUID).toBe(DATA) // the placed DATA rides in refUID
    expect(pin?.dataRefs).toEqual([]) // anchor is concrete, no fresh sibling
    expect(pin?.data).toBe(pinEnc.encodeData([ANCHOR])) // definition = anchor
  })
})

// ── Mock chain for the submit path ──────────────────────────────────────────────

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

/** A mock submit context recording each layer's multiAttest requests. */
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
    // The layered boundary's placement gates (STAMPED pin plans) read the EAS
    // attestation + the indexer's mirror scan through the SUBMIT context's
    // client. Defaults model a healthy self-authored DATA at a real ANCHOR;
    // pins.place's own guarded inline gates fire FIRST, so negatives keep
    // their tailored errors.
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      if (args.functionName === 'getAttestation') {
        const [queried] = (args.args ?? []) as [Hex]
        if (queried === uid(0x800)) return { uid: queried, schema: SCHEMAS.anchor }
        return { uid: queried, attester: ATTESTER, schema: SCHEMAS.data }
      }
      if (args.functionName === 'getReferencingBySchemaAndAttesterCount') return 1n
      if (args.functionName === 'getReferencingBySchemaAndAttester') return [uid(0x3141)]
      throw new Error(`submit-ctx mock: unexpected readContract ${args.functionName}`)
    },
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
      indexerAddress: addr(0x1dc5),
      chainId: 11155111,
      attester: ATTESTER,
      account: ATTESTER,
    },
  }
}

/** A mock read client dispatching `readContract` by (address, functionName). */
function makeReadClient(handler: (fn: string, args: readonly unknown[]) => unknown): {
  readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown>
} {
  return {
    async readContract(a: { functionName: string; args?: readonly unknown[] }) {
      return handler(a.functionName, a.args ?? [])
    },
  }
}

// ── tags namespace ──────────────────────────────────────────────────────────────

describe('makeTagsNs', () => {
  const TARGET = uid(0x500)
  const DEF = uid(0x600)

  it('add emits a TAG with the right definition/target/weight and submits (1 sig)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async (schema, u) => {
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
    })

    const receipt = await tags.add(TARGET, DEF, { weight: 5n })
    expect(receipt.signatureCount).toBe(1) // single layer → one popup
    expect(receipt.steps).toHaveLength(1)
    // One multiAttest, one entry: the TAG.
    expect(calls).toHaveLength(1)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.refUID).toBe(TARGET)
    expect(entry?.revocable).toBe(true)
    expect(entry?.data).toBe(tagEnc.encodeData([DEF, 5n]))
    expect(revokeCall).toBeUndefined()
  })

  it('resolves a /tags/<name> label to its definition anchor UID before tagging', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const DEF_ANCHOR = uid(0x6aa)
    const reads: { fn: string; args: readonly unknown[] }[] = []
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        reads.push({ fn, args })
        if (fn === 'rootAnchorUID') return uid(0x1)
        if (fn === 'resolvePath') return DEF_ANCHOR // /tags then nsfw both resolve
        return uid(0)
      }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0xfee),
    })

    await tags.add(TARGET, 'nsfw')
    const entry = calls[0]?.[0]?.data[0]
    // data = (definitionAnchor, defaultWeight)
    expect(entry?.data).toBe(tagEnc.encodeData([DEF_ANCHOR, DEFAULT_TAG_WEIGHT]))
    expect(reads.some((r) => r.fn === 'resolvePath')).toBe(true)
  })

  it('add guards the live chain BEFORE the definition-resolution read (WrongChain, no read, no submit)', async () => {
    // The /tags/<name> resolution FEEDS the plan, so a drifted public client could resolve
    // it on the wrong chain. The guard must run BEFORE that read — a path definition would
    // trigger a read if not guarded; assert it never fires and nothing submits.
    const { ctx, calls } = makeSubmitCtx()
    let readCalled = false
    const tags = makeTagsNs({
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
    const err = await tags.add(TARGET, 'nsfw').catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
    expect(readCalled).toBe(false) // definition-resolution read never ran
    expect(calls).toHaveLength(0) // nothing submitted
  })

  it('add routes the definition-resolution walk through the chain-pinned client', async () => {
    // r3740769002: the /tags/<name> walk FEEDS the plan, so it must go through
    // `guardReadClient(dep.chainId)` like the mirror/property planners —
    // `assertChain` samples once, and a provider drifting mid-walk could
    // resolve a chain-B definition UID into the chain-A plan. Prove the raw
    // fallback is untouched when the guard is supplied.
    const { ctx, calls } = makeSubmitCtx()
    const DEF_ANCHOR = uid(0x6aa)
    const guarded = makeReadClient((fn) => {
      if (fn === 'rootAnchorUID') return uid(0x1)
      if (fn === 'resolvePath') return DEF_ANCHOR
      return uid(0)
    })
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      guardReadClient: () => guarded as never,
      publicClient: makeReadClient(() => {
        throw new Error('unguarded publicClient used by add definition walk')
      }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0xfee),
    })
    await tags.add(TARGET, 'nsfw')
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.data).toBe(tagEnc.encodeData([DEF_ANCHOR, DEFAULT_TAG_WEIGHT]))
  })

  it('remove revokes the right UID under the TAG schema', async () => {
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async (schema, u) => {
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
    })
    const tagUID = uid(0xabc)
    const tx = await tags.remove(tagUID)
    expect(tx).toBe(uid(0xfee))
    expect(revokeCall).toEqual({ schema: SCHEMAS.tag, uid: tagUID })
  })

  it('active reads getActiveTagWeight (revoked excluded)', async () => {
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getActiveTagWeight') {
          // (attester, target, definition, targetSchema)
          expect(args).toEqual([ATTESTER, TARGET, DEF, SCHEMAS.anchor])
          return [true, 9n]
        }
        return uid(0)
      }) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    expect(await tags.active(ATTESTER, TARGET, DEF)).toEqual({ weight: 9n })
  })

  it('active returns undefined when no active TAG', async () => {
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => [false, 0n]) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    expect(await tags.active(ATTESTER, TARGET, DEF)).toBeUndefined()
  })

  it('active honors a custom targetSchema (non-anchor target)', async () => {
    const CUSTOM = uid(0xc5)
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getActiveTagWeight') {
          expect(args).toEqual([ATTESTER, TARGET, DEF, CUSTOM])
          return [true, 1n]
        }
        return uid(0)
      }) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    expect(await tags.active(ATTESTER, TARGET, DEF, { targetSchema: CUSTOM })).toEqual({
      weight: 1n,
    })
  })

  it('list returns one entry per lens attester with an active TAG', async () => {
    const A = addr(0x1)
    const B = addr(0x2)
    const tags = makeTagsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getActiveTagWeight') {
          const who = args[0] as Address
          return who === A ? [true, 3n] : [false, 0n]
        }
        return uid(0)
      }) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const out = await tags.list(TARGET, DEF, { lens: [A, B] })
    expect(out).toEqual([{ attester: A, weight: 3n }])
  })
})

// ── props namespace ─────────────────────────────────────────────────────────────

describe('makePropsNs', () => {
  const DATA = uid(0x700)
  const KEY = 'author'
  const VALUE = 'alice'
  const KEY_ANCHOR = uid(0x701)
  const PROP_UID = uid(0x702)

  function readContext() {
    // The read engine's ReadContext, with a publicClient that resolves the property
    // lookup (resolveAnchor → getActivePinTarget → getAttestation.data).
    return {
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'resolveAnchor') {
          // (dataUID, key, PROPERTY_SCHEMA) → key anchor
          return args[1] === KEY ? KEY_ANCHOR : uid(0)
        }
        if (fn === 'getActivePinTarget') {
          // (keyAnchor, attester, PROPERTY_SCHEMA) → property UID
          return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
        }
        if (fn === 'getAttestation') {
          return { data: propEnc.encodeData([VALUE]) }
        }
        return uid(0)
      }),
      deployment,
      account: ATTESTER,
    } as never
  }

  it('set emits the triple threaded correctly across two layers (two signatures)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      readContext,
      submitContext: () => ctx,
      attester: () => ATTESTER,
    })
    const receipt = await props.set(DATA, KEY, VALUE)
    expect(receipt.signatureCount).toBe(2) // two layers → two popups
    expect(receipt.steps).toHaveLength(3) // anchor + property + binding-pin

    // Layer 1: key-ANCHOR + PROPERTY (two schemas).
    expect(calls).toHaveLength(2)
    const l1 = calls[0] ?? []
    const anchorReq = l1.find((r) => r.schema === SCHEMAS.anchor)
    const propReq = l1.find((r) => r.schema === SCHEMAS.property)
    expect(anchorReq?.data[0]?.refUID).toBe(DATA)
    expect(anchorReq?.data[0]?.data).toBe(anchorEnc.encodeData([KEY, SCHEMAS.property]))
    expect(propReq?.data[0]?.data).toBe(propEnc.encodeData([VALUE]))

    // Layer 2: binding-PIN. Its refUID is the mined PROPERTY UID; its data.definition
    // is the mined key-ANCHOR UID (both threaded from layer 1's Attested events).
    const l2 = calls[1] ?? []
    const pinReq = l2.find((r) => r.schema === SCHEMAS.pin)
    expect(pinReq).toBeDefined()
    const minedAnchor = uid(0xd000) // first Attested in layer 1
    const minedProp = uid(0xd001) // second Attested in layer 1
    expect(pinReq?.data[0]?.refUID).toBe(minedProp)
    const [definition] = decodeAbiParameters(
      [{ type: 'bytes32' }],
      pinReq?.data[0]?.data as Hex,
    ) as [Hex]
    expect(definition).toBe(minedAnchor)
  })

  it('set on a NEW key resolves the key anchor first (absent ⇒ full triple)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const reads: { fn: string; args: readonly unknown[] }[] = []
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        reads.push({ fn, args })
        return uid(0) // resolveAnchor → ZERO ⇒ new key
      }) as never,
      readContext,
      submitContext: () => ctx,
      attester: () => ATTESTER,
    })
    await props.set(DATA, KEY, VALUE)
    // The overwrite probe ran: resolveAnchor(dataUID, key, PROPERTY_SCHEMA).
    const probe = reads.find((r) => r.fn === 'resolveAnchor')
    expect(probe?.args).toEqual([DATA, KEY, SCHEMAS.property])
    // Full triple (key-ANCHOR + PROPERTY + binding-PIN) across two layers.
    const l1 = calls[0] ?? []
    expect(l1.some((r) => r.schema === SCHEMAS.anchor)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('set on an EXISTING key emits ONLY PROPERTY + binding-PIN bound to the existing anchor (Bug-2)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        // resolveAnchor(dataUID, key, PROPERTY_SCHEMA) → the existing key anchor.
        if (fn === 'resolveAnchor' && args[1] === KEY) return KEY_ANCHOR
        return uid(0)
      }) as never,
      readContext,
      submitContext: () => ctx,
      attester: () => ATTESTER,
    })
    const receipt = await props.set(DATA, KEY, 'newValue')

    // No fresh key-ANCHOR is minted (the permanent existing one is reused).
    const allEntries = calls.flat()
    expect(allEntries.some((r) => r.schema === SCHEMAS.anchor)).toBe(false)
    // Two attestations total: the fresh PROPERTY + the binding-PIN.
    expect(receipt.steps).toHaveLength(2)

    // The fresh PROPERTY carries the new value.
    const propReq = allEntries.find((r) => r.schema === SCHEMAS.property)
    expect(propReq?.data[0]?.data).toBe(propEnc.encodeData(['newValue']))

    // The binding-PIN's definition is the CONCRETE existing key anchor (encoded in the
    // first layer already — no symbolic thread), and its refUID is the mined PROPERTY.
    const pinReq = allEntries.find((r) => r.schema === SCHEMAS.pin)
    expect(pinReq).toBeDefined()
    const [definition] = decodeAbiParameters(
      [{ type: 'bytes32' }],
      pinReq?.data[0]?.data as Hex,
    ) as [Hex]
    expect(definition).toBe(KEY_ANCHOR)
  })

  it('set guards the live chain BEFORE the key-anchor planning read (WrongChain, no read, no submit)', async () => {
    // The resolveAnchor lookup FEEDS the plan, so it must be guarded: a drifted public
    // client could resolve a key-anchor that only exists on the wrong chain, poisoning the
    // plan. The guard must run BEFORE the read — assert the read never fires and nothing submits.
    const { ctx, calls } = makeSubmitCtx()
    let readCalled = false
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => {
        readCalled = true
        return uid(0)
      }) as never,
      readContext,
      submitContext: () => ({
        ...ctx,
        assertChain: async () => {
          throw Object.assign(new Error('wrong chain'), { code: 'WrongChain' })
        },
      }),
      attester: () => ATTESTER,
    })
    const err = await props.set(DATA, KEY, VALUE).catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
    expect(readCalled).toBe(false) // planning read never ran
    expect(calls).toHaveLength(0) // nothing submitted
  })

  it('set routes the key-anchor planning read through the chain-pinned client', async () => {
    // r3740726896: the resolveAnchor lookup FEEDS the plan, so it must go through
    // `guardReadClient(dep.chainId)` like every other planner — `assertChain` samples
    // once, and a provider drifting AFTER it could feed a wrong-chain key-anchor UID
    // into the plan (layer-1 PROPERTY mines, layer-2 binding PIN reverts: partial
    // write). Prove the raw fallback is untouched when the guard is supplied.
    const { ctx, calls } = makeSubmitCtx()
    const guarded = makeReadClient((fn) => (fn === 'resolveAnchor' ? KEY_ANCHOR : uid(0)))
    const props = makePropsNs({
      getDeployment: () => deployment,
      guardReadClient: () => guarded as never,
      publicClient: makeReadClient(() => {
        throw new Error('unguarded publicClient used by set planning read')
      }) as never,
      readContext,
      submitContext: () => ctx,
      attester: () => ATTESTER,
    })
    await props.set(DATA, KEY, VALUE)
    // The reused existing key-anchor proves the GUARDED client served the lookup:
    // no fresh key-ANCHOR is minted, and the binding-PIN binds the existing one.
    const allEntries = calls.flat()
    expect(allEntries.some((r) => r.schema === SCHEMAS.anchor)).toBe(false)
    const pinReq = allEntries.find((r) => r.schema === SCHEMAS.pin)
    const [definition] = decodeAbiParameters(
      [{ type: 'bytes32' }],
      pinReq?.data[0]?.data as Hex,
    ) as [Hex]
    expect(definition).toBe(KEY_ANCHOR)
  })

  it('get reads the active value the lens attester bound', async () => {
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      readContext,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
    })
    expect(await props.get(DATA, KEY)).toBe(VALUE)
    expect(await props.get(DATA, 'missing')).toBeUndefined()
  })

  it('list enumerates key-ANCHORs, decodes names, reads values', async () => {
    const props = makePropsNs({
      getDeployment: () => deployment,
      // In production the enumeration AND the per-key value reads go through ONE client
      // (the chain-pinned `pc`); the mock serves the full set: enumeration + the
      // resolveAnchor/getActivePinTarget/getAttestation the value read needs.
      publicClient: makeReadClient((fn, args) => {
        // CANONICAL, attester-independent enumeration (a flat bytes32[], not a cursor
        // tuple). The address-list variant must NOT be used (it would scope to the
        // binding attester and drop reused anchors).
        if (fn === 'getAnchorsBySchemaAndAddressList') throw new Error('used address-list variant')
        if (fn === 'getChildCountBySchema') return 1n
        if (fn === 'getChildCountBySchema') return 1n
        if (fn === 'getAnchorsBySchema') return [KEY_ANCHOR]
        if (fn === 'resolveAnchor') return args[1] === KEY ? KEY_ANCHOR : uid(0)
        if (fn === 'getActivePinTarget') return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
        if (fn === 'getAttestation') {
          // The key-ANCHOR's attestation → decode the name; the PROPERTY UID → decode value.
          if (args[0] === KEY_ANCHOR) return { data: anchorEnc.encodeData([KEY, SCHEMAS.property]) }
          return { data: propEnc.encodeData([VALUE]) }
        }
        return uid(0)
      }) as never,
      readContext,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
    })
    const out = await props.list(DATA)
    expect(out).toEqual([{ key: KEY, value: VALUE, propertyUID: PROP_UID }])
  })

  it('list includes a key whose anchor a DIFFERENT attester minted (get/list parity)', async () => {
    // The get/list-divergence Codex flagged: `set` REUSES a canonical key-anchor, so a
    // lens attester (BOB) can bind an active value to an anchor ALICE minted first. The
    // enumeration is attester-independent (getAnchorsBySchema), and the value read is
    // lens-scoped (readContext resolves BOB's binding), so `list` includes the key —
    // matching what `get` returns. The old address-list enumeration (scoped to BOB)
    // would have omitted ALICE's anchor entirely.
    const BOB = '0x000000000000000000000000000000000000B0B0' as const
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getAnchorsBySchemaAndAddressList') throw new Error('used address-list variant')
        // Canonical set under (DATA, PROPERTY) — returned regardless of which attester
        // (ALICE) minted the anchor.
        if (fn === 'getChildCountBySchema') return 1n
        if (fn === 'getChildCountBySchema') return 1n
        if (fn === 'getAnchorsBySchema') return [KEY_ANCHOR]
        // The value read (BOB's binding) goes through this same pinned client in production.
        if (fn === 'resolveAnchor') return args[1] === KEY ? KEY_ANCHOR : uid(0)
        if (fn === 'getActivePinTarget') return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
        if (fn === 'getAttestation') {
          if (args[0] === KEY_ANCHOR) return { data: anchorEnc.encodeData([KEY, SCHEMAS.property]) }
          return { data: propEnc.encodeData([VALUE]) }
        }
        return uid(0)
      }) as never,
      readContext, // props.get (below) still resolves the lens's active binding via readContext
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => BOB,
    })
    expect(await props.get(DATA, KEY, { lens: BOB })).toBe(VALUE)
    expect(await props.list(DATA, { lens: BOB })).toEqual([
      { key: KEY, value: VALUE, propertyUID: PROP_UID },
    ])
  })

  it('list pages by offset until a short page (does not truncate at one page)', async () => {
    let pageCalls = 0
    // A full first page (256 distinct anchors) forces a second offset read; only the
    // KEY anchor resolves to a bound value, the filler anchors resolve to none and are
    // dropped. The bug stopped after one page; the fix advances `start` until a short
    // page. The KEY anchor sits at the END of page 1 to prove the whole page is read.
    const PAGE = 256
    const page1 = Array.from({ length: PAGE }, (_, i) =>
      i === PAGE - 1 ? KEY_ANCHOR : uid(0x2000 + i),
    )
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        // RAW count 257: a full first page + a 1-item second (the pager walks
        // the raw count, never probing past it — r3741115239).
        if (fn === 'getChildCountBySchema') return 257n
        if (fn === 'getAnchorsBySchema') {
          pageCalls += 1
          const start = args[2] as bigint
          return start === 0n ? page1 : [uid(0x2fff)]
        }
        // Value read (one pinned client): only the KEY anchor resolves to a bound value.
        if (fn === 'resolveAnchor') return args[1] === KEY ? KEY_ANCHOR : uid(0)
        if (fn === 'getActivePinTarget') return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
        if (fn === 'getAttestation') {
          if (args[0] === KEY_ANCHOR) return { data: anchorEnc.encodeData([KEY, SCHEMAS.property]) }
          if (args[0] === PROP_UID) return { data: propEnc.encodeData([VALUE]) }
          // Filler anchors decode to distinct keys the lens never bound.
          return { data: anchorEnc.encodeData([`k${String(args[0])}`, SCHEMAS.property]) }
        }
        return uid(0)
      }) as never,
      readContext,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
    })
    const out = await props.list(DATA)
    expect(pageCalls).toBe(2) // advanced past the full first page into the raw remainder
    expect(out).toEqual([{ key: KEY, value: VALUE, propertyUID: PROP_UID }])
  })

  it('list stops AT the raw count — an exact page multiple sends no reverting extra probe (r3741115239)', async () => {
    // Exactly 256 property anchors: the old full-page-implies-more loop probed
    // start=256, which the slice helper REVERTS (InvalidOffset) — the whole
    // list failed instead of returning the properties.
    let pageCalls = 0
    const page1 = Array.from({ length: 256 }, (_, i) => (i === 0 ? KEY_ANCHOR : uid(0x3000 + i)))
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getChildCountBySchema') return 256n
        if (fn === 'getAnchorsBySchema') {
          pageCalls += 1
          if ((args[2] as bigint) !== 0n) throw new Error('InvalidOffset')
          return page1
        }
        if (fn === 'resolveAnchor') return args[1] === KEY ? KEY_ANCHOR : uid(0)
        if (fn === 'getActivePinTarget') return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
        if (fn === 'getAttestation') {
          if (args[0] === KEY_ANCHOR) return { data: anchorEnc.encodeData([KEY, SCHEMAS.property]) }
          if (args[0] === PROP_UID) return { data: propEnc.encodeData([VALUE]) }
          return { data: anchorEnc.encodeData([`k${String(args[0])}`, SCHEMAS.property]) }
        }
        return uid(0)
      }) as never,
      readContext,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
    })
    const out = await props.list(DATA)
    expect(pageCalls).toBe(1) // one full window, no probe past the raw end
    expect(out).toEqual([{ key: KEY, value: VALUE, propertyUID: PROP_UID }])
  })

  it('list routes ALL reads (enumeration + getAttestation + values) through the chain-pinned client', async () => {
    // The TOCTOU fix: the anchor page, the name `getAttestation`, AND the per-key value reads
    // must all go through the guarded `pc` pinned to the resolved deployment — never
    // deps.publicClient directly nor a re-resolving deps.readContext(). Prove it by making
    // both fallbacks throw and serving every read from the guarded client.
    const full = makeReadClient((fn, args) => {
      if (fn === 'getChildCountBySchema') return 1n
      if (fn === 'getAnchorsBySchema') return [KEY_ANCHOR]
      if (fn === 'resolveAnchor') return args[1] === KEY ? KEY_ANCHOR : uid(0)
      if (fn === 'getActivePinTarget') return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
      if (fn === 'getAttestation') {
        if (args[0] === KEY_ANCHOR) return { data: anchorEnc.encodeData([KEY, SCHEMAS.property]) }
        return { data: propEnc.encodeData([VALUE]) }
      }
      return uid(0)
    })
    const props = makePropsNs({
      getDeployment: () => deployment,
      liveDeployment: () => deployment,
      guardReadClient: () => full as never,
      // Both fallbacks must be UNUSED by list — they throw if touched.
      publicClient: makeReadClient(() => {
        throw new Error('unguarded publicClient used by list')
      }) as never,
      readContext: () => {
        throw new Error('readContext re-resolved by list')
      },
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
    })
    expect(await props.list(DATA)).toEqual([{ key: KEY, value: VALUE, propertyUID: PROP_UID }])
  })
})

// ── pins namespace ──────────────────────────────────────────────────────────────

describe('makePinsNs', () => {
  const ANCHOR = uid(0x800)
  const DATA = uid(0x900)

  /** The place() gate's EAS read: self-authored DATA by default. */
  const gateClient = (over?: {
    attester?: Address
    schema?: Hex
    anchorSchema?: Hex
    mirrors?: bigint
  }) =>
    makeReadClient((fn, args) => {
      if (fn === 'getAttestation') {
        // Dispatch on the queried UID: the gate reads BOTH sides of the PIN.
        if (args[0] === ANCHOR) {
          return { attester: ATTESTER, schema: over?.anchorSchema ?? SCHEMAS.anchor }
        }
        return { attester: over?.attester ?? ATTESTER, schema: over?.schema ?? SCHEMAS.data }
      }
      // The readability proof's active-mirror scan.
      if (fn === 'getReferencingBySchemaAndAttesterCount') return over?.mirrors ?? 1n
      if (fn === 'getReferencingBySchemaAndAttester') {
        return (over?.mirrors ?? 1n) > 0n ? [uid(0x3141)] : []
      }
      return uid(0)
    })

  it('place emits the placement PIN and submits (one signature)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: gateClient() as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const receipt = await pins.place(ANCHOR, DATA)
    expect(receipt.signatureCount).toBe(1)
    expect(calls).toHaveLength(1)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.refUID).toBe(DATA) // placed DATA in refUID
    expect(entry?.revocable).toBe(true)
    expect(entry?.data).toBe(pinEnc.encodeData([ANCHOR])) // definition = anchor
  })

  it('place REFUSES foreign-authored DATA — nothing submits (r3741216395)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: gateClient({ attester: addr(0xbeef) }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const err = await pins.place(ANCHOR, DATA).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/INVISIBLE under your lens/)
    expect(calls).toHaveLength(0)
  })

  it('place REFUSES a self-authored NON-DATA target — nothing submits (r3741216397)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: gateClient({ schema: SCHEMAS.anchor }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const err = await pins.place(ANCHOR, DATA).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/not a DATA attestation/)
    expect(calls).toHaveLength(0)
  })

  it('place REFUSES a bare DATA with NO active mirror — unreadable placement (r3741250932)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: gateClient({ mirrors: 0n }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const err = await pins.place(ANCHOR, DATA).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/NO active mirror/)
    expect(calls).toHaveLength(0)
  })

  it('place REFUSES a non-ANCHOR definition — undiscoverable placement (r3741271349)', async () => {
    // EdgeResolver accepts any existing attestation as the definition, but path
    // resolution only finds PINs hanging off ANCHOR nodes.
    const { ctx, calls } = makeSubmitCtx()
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: gateClient({ anchorSchema: SCHEMAS.property }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    const err = await pins.place(ANCHOR, DATA).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/not an ANCHOR attestation/)
    expect(calls).toHaveLength(0)
  })

  it('the RAW builder+executor pair is gated too — a foreign target refuses at the boundary (r3741335344)', async () => {
    // buildPlacementPinPlan + submitEdgePlan bypasses pins.place's inline
    // gates; the plan's stamps make the layered boundary run them instead.
    const { ctx, calls } = makeSubmitCtx()
    const foreignCtx = {
      ...ctx,
      publicClient: {
        ...ctx.publicClient,
        async readContract(args: { functionName: string; args?: readonly unknown[] }) {
          if (args.functionName === 'getAttestation') {
            return { attester: addr(0xbeef), schema: SCHEMAS.data } // foreign author
          }
          return (
            ctx.publicClient as unknown as {
              readContract: (a: unknown) => Promise<unknown>
            }
          ).readContract(args)
        },
      },
    } as typeof ctx
    const plan = buildPlacementPinPlan(SCHEMAS, ANCHOR, DATA)
    const err = await submitEdgePlan(plan, foreignCtx).catch((e) => e)
    expect((err as { code?: string }).code).toBe('InvalidArgument')
    expect(String((err as Error).message)).toMatch(/INVISIBLE under your lens/)
    expect(calls).toHaveLength(0)
  })

  it('unplace revokes the right UID under the PIN schema', async () => {
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async (schema, u) => {
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
    })
    const pinUID = uid(0xabc)
    const tx = await pins.unplace(pinUID)
    expect(tx).toBe(uid(0xfee))
    expect(revokeCall).toEqual({ schema: SCHEMAS.pin, uid: pinUID })
  })

  it('active reads getActivePinTarget for the slot', async () => {
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getActivePinTarget') {
          // (anchor, attester, DATA_SCHEMA)
          expect(args).toEqual([ANCHOR, ATTESTER, SCHEMAS.data])
          return DATA
        }
        return uid(0)
      }) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    expect(await pins.active(ANCHOR)).toBe(DATA)
  })

  it('active with NO attester and NO connected account throws LensRequired — never a false absence (r3741157009)', async () => {
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => {
        throw new Error('no read should happen without an effective attester')
      }) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => undefined, // read-only client, no lens
      revoke: async () => uid(0),
    })
    await expect(pins.active(ANCHOR)).rejects.toMatchObject({ code: 'LensRequired' })
  })

  it('active returns undefined for an empty slot', async () => {
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      submitContext: () => makeSubmitCtx().ctx,
      attester: () => ATTESTER,
      revoke: async () => uid(0),
    })
    expect(await pins.active(ANCHOR)).toBeUndefined()
  })
})

// ── resolveTagDefinition (label vs UID) ─────────────────────────────────────────

describe('resolveTagDefinition', () => {
  it('passes a 32-byte UID through unchanged', async () => {
    const DEF = uid(0x600)
    const out = await resolveTagDefinition(
      makeReadClient(() => {
        throw new Error('should not read for a UID')
      }) as never,
      INDEXER,
      DEF,
    )
    expect(out).toBe(DEF)
  })

  it('resolves a bare label to /tags/<name>', async () => {
    const ANCHOR = uid(0x6aa)
    const paths: string[] = []
    const out = await resolveTagDefinition(
      makeReadClient((fn, args) => {
        if (fn === 'rootAnchorUID') return uid(0x1)
        if (fn === 'resolvePath') {
          paths.push(args[1] as string)
          return ANCHOR
        }
        return uid(0)
      }) as never,
      INDEXER,
      'nsfw',
    )
    expect(out).toBe(ANCHOR)
    expect(paths).toEqual(['tags', 'nsfw'])
  })
})

// ── Canonical property keys (specs/02) ──────────────────────────────────────────

describe('makePropsNs — canonical key encoding (specs/02)', () => {
  const DATA = uid(0x900)
  const HUMAN_KEY = 'my key' // contains a space → canonical 'my%20key'
  const CANONICAL_KEY = 'my%20key'
  const KEY_ANCHOR = uid(0x901)
  const PROP_UID = uid(0x902)
  const VALUE = 'v'

  it('set resolves + plans under the CANONICAL key (a raw space would revert the L1 multiAttest)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const reads: { fn: string; args: readonly unknown[] }[] = []
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        reads.push({ fn, args })
        return uid(0) // absent → full triple
      }) as never,
      readContext: () => ({ publicClient: makeReadClient(() => uid(0)), deployment }) as never,
      submitContext: () => ctx,
      attester: () => ATTESTER,
    })
    await props.set(DATA, HUMAN_KEY, VALUE)
    // The update-detection read used the canonical key…
    const anchorRead = reads.find((r) => r.fn === 'resolveAnchor')
    expect(anchorRead?.args[1]).toBe(CANONICAL_KEY)
    // …and the planned key-ANCHOR payload carries the canonical name.
    const l1 = calls[0] ?? []
    const anchorReq = l1.find((r) => r.schema === SCHEMAS.anchor)
    expect(anchorReq?.data[0]?.data).toBe(anchorEnc.encodeData([CANONICAL_KEY, SCHEMAS.property]))
  })

  it('get(human key) reads the canonical slot set() wrote', async () => {
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
      readContext: () =>
        ({
          publicClient: makeReadClient((fn, args) => {
            if (fn === 'resolveAnchor') return args[1] === CANONICAL_KEY ? KEY_ANCHOR : uid(0)
            if (fn === 'getActivePinTarget') return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
            if (fn === 'getAttestation') return { data: propEnc.encodeData([VALUE]) }
            return uid(0)
          }),
          deployment,
          account: ATTESTER,
        }) as never,
      submitContext: () => {
        throw new Error('unused')
      },
      attester: () => ATTESTER,
    })
    expect(await props.get(DATA, HUMAN_KEY)).toBe(VALUE)
  })

  it('list returns HUMAN keys (decodes the canonical on-chain names)', async () => {
    // The per-key value read routes through the pinned client (same mock): give it
    // an active binding so the entry survives the filter.
    const withValues = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getChildCountBySchema') return 1n
        if (fn === 'getChildCountBySchema') return 1n
        if (fn === 'getAnchorsBySchema') return [KEY_ANCHOR]
        if (fn === 'getAttestation' && args[0] === KEY_ANCHOR) {
          return { data: anchorEnc.encodeData([CANONICAL_KEY, SCHEMAS.property]) }
        }
        if (fn === 'resolveAnchor') return args[1] === CANONICAL_KEY ? KEY_ANCHOR : uid(0)
        if (fn === 'getActivePinTarget') return args[0] === KEY_ANCHOR ? PROP_UID : uid(0)
        if (fn === 'getAttestation') return { data: propEnc.encodeData([VALUE]) }
        return uid(0)
      }) as never,
      readContext: () => {
        throw new Error('unused')
      },
      submitContext: () => {
        throw new Error('unused')
      },
      attester: () => ATTESTER,
    })
    const out = await withValues.list(DATA)
    expect(out).toEqual([{ key: HUMAN_KEY, value: VALUE, propertyUID: PROP_UID }])
  })
})
