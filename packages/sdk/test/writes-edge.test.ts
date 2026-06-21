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
import type { EdgeSubmitContext } from '../src/writes/edge-submit.js'
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
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getAnchorsBySchemaAndAddressList') return [[KEY_ANCHOR], 0n]
        if (fn === 'getAttestation') {
          // The key-ANCHOR's attestation → decode the name.
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

  it('list pages until the cursor is exhausted (does not truncate at one page)', async () => {
    let pageCalls = 0
    const props = makePropsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient((fn, args) => {
        if (fn === 'getAnchorsBySchemaAndAddressList') {
          pageCalls += 1
          const cursor = args[3] as bigint
          // Page 1 (cursor 0) returns one anchor + a NON-zero next cursor (more to
          // come); page 2 (cursor 256) returns empty + zero (exhausted). The bug
          // stopped after page 1; the fix follows the cursor to page 2.
          return cursor === 0n ? [[KEY_ANCHOR], 256n] : [[], 0n]
        }
        if (fn === 'getAttestation') {
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
    expect(pageCalls).toBe(2) // followed the non-zero cursor to the second page
    expect(out).toEqual([{ key: KEY, value: VALUE, propertyUID: PROP_UID }])
  })
})

// ── pins namespace ──────────────────────────────────────────────────────────────

describe('makePinsNs', () => {
  const ANCHOR = uid(0x800)
  const DATA = uid(0x900)

  it('place emits the placement PIN and submits (one signature)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const pins = makePinsNs({
      getDeployment: () => deployment,
      publicClient: makeReadClient(() => uid(0)) as never,
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
