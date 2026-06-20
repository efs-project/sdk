/**
 * Curated-collection (LIST) write primitives — the pure plan builders
 * (`buildCreateListPlan` / `buildAddEntryPlan`), the client-side validation guards
 * (`validateListConfig` / `validateAddTarget`), and the `efs.lists` write namespace
 * verbs (`makeListsWriteNs.create/add/remove`) over mock clients. No live chain.
 *
 * Mirrors the Solidity wrappers' encodings (`EFSLib.createList` / `addEntry` /
 * `addAddressEntry`): LIST `abi.encode(allowsDuplicates, appendOnly, targetType,
 * targetSchema, maxEntries)` non-revocable refUID 0 recipient 0; LIST_ENTRY for
 * ANY/SCHEMA `abi.encode(listUID, target)` recipient 0; ADDR member in `recipient`
 * with payload `abi.encode(listUID, bytes32(0))`.
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
import { InvalidListConfig, ListAppendOnly, ListNotFound } from '../src/errors.js'
import type { EdgeSubmitContext } from '../src/writes/edge-submit.js'
import {
  EDGE_REF,
  TARGET_TYPE_CODE,
  buildAddEntryPlan,
  buildCreateListPlan,
  validateAddTarget,
  validateListConfig,
} from '../src/writes/edge.js'
import { makeListsWriteNs } from '../src/writes/lists.js'

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address
const ZERO_UID = uid(0)
const ZERO_ADDR = addr(0)

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
const ATTESTER = addr(0xacc01)

const deployment: EfsDeployment = {
  chainId: 11155111,
  schemas: SCHEMAS,
  contracts: {
    eas: EAS,
    schemaRegistry: addr(0x5c),
    indexer: addr(0x1de7),
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

const listEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.list)
const listEntryEnc = new SchemaEncoder(EFS_SCHEMA_FIELDS.listEntry)

// ── Pure builders ───────────────────────────────────────────────────────────────

describe('buildCreateListPlan', () => {
  it('encodes a SCHEMA-mode LIST: non-revocable, refUID 0, recipient 0 (default)', () => {
    const targetSchema = uid(0x999)
    const plan = buildCreateListPlan(SCHEMAS, {
      allowsDuplicates: false,
      appendOnly: false,
      targetType: 'schema',
      targetSchema,
      maxEntries: 5n,
    })
    expect(plan.attestations).toHaveLength(1)
    const list = plan.attestations[0]
    expect(list?.kind).toBe('LIST')
    expect(list?.layer).toBe(1)
    expect(list?.schema).toBe(SCHEMAS.list)
    expect(list?.revocable).toBe(false) // LIST must be non-revocable
    expect(list?.refUID).toBe(ZERO_UID) // free-floating
    expect(list?.recipient).toBeUndefined() // → ZERO_ADDRESS at materialize
    // data = abi.encode(allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries)
    expect(list?.data).toBe(
      listEnc.encodeData([false, false, TARGET_TYPE_CODE.schema, targetSchema, 5n]),
    )
  })

  it('encodes an ANY-mode LIST with zeroed targetSchema/maxEntries defaults', () => {
    const plan = buildCreateListPlan(SCHEMAS, {
      allowsDuplicates: true,
      appendOnly: false,
      targetType: 'any',
    })
    const list = plan.attestations[0]
    expect(list?.data).toBe(listEnc.encodeData([true, false, TARGET_TYPE_CODE.any, ZERO_UID, 0n]))
  })

  it('encodes an ADDR-mode LIST', () => {
    const plan = buildCreateListPlan(SCHEMAS, {
      allowsDuplicates: false,
      appendOnly: true,
      targetType: 'addr',
      maxEntries: 0n,
    })
    const list = plan.attestations[0]
    expect(list?.data).toBe(listEnc.encodeData([false, true, TARGET_TYPE_CODE.addr, ZERO_UID, 0n]))
  })
})

describe('validateListConfig (the create-invariant guards)', () => {
  it('rejects targetType out of range (>2)', () => {
    expect(() =>
      validateListConfig({
        allowsDuplicates: false,
        appendOnly: false,
        // a JS caller bypassing the literal union with `as`.
        targetType: 'bogus' as never,
      }),
    ).toThrow(InvalidListConfig)
  })

  it('rejects SCHEMA mode with a zero targetSchema', () => {
    expect(() =>
      validateListConfig({ allowsDuplicates: false, appendOnly: false, targetType: 'schema' }),
    ).toThrow(/schema.*requires a nonzero targetSchema/i)
  })

  it('rejects non-SCHEMA mode with a nonzero targetSchema (ANY)', () => {
    expect(() =>
      validateListConfig({
        allowsDuplicates: false,
        appendOnly: false,
        targetType: 'any',
        targetSchema: uid(0x123),
      }),
    ).toThrow(/must have a zero targetSchema/i)
  })

  it('rejects non-SCHEMA mode with a nonzero targetSchema (ADDR)', () => {
    expect(() =>
      validateListConfig({
        allowsDuplicates: false,
        appendOnly: false,
        targetType: 'addr',
        targetSchema: uid(0x123),
      }),
    ).toThrow(InvalidListConfig)
  })

  it('rejects appendOnly && allowsDuplicates with maxEntries 0', () => {
    expect(() =>
      validateListConfig({
        allowsDuplicates: true,
        appendOnly: true,
        targetType: 'any',
        maxEntries: 0n,
      }),
    ).toThrow(/nonzero maxEntries/i)
  })

  it('accepts appendOnly && allowsDuplicates WITH a nonzero maxEntries', () => {
    expect(
      validateListConfig({
        allowsDuplicates: true,
        appendOnly: true,
        targetType: 'any',
        maxEntries: 10n,
      }),
    ).toEqual({ targetSchema: ZERO_UID, maxEntries: 10n })
  })

  it('buildCreateListPlan throws on a bad config (before submit)', () => {
    expect(() =>
      buildCreateListPlan(SCHEMAS, {
        allowsDuplicates: false,
        appendOnly: false,
        targetType: 'schema',
      }),
    ).toThrow(InvalidListConfig)
  })
})

describe('buildAddEntryPlan', () => {
  const LIST = uid(0x500)

  it('ANY: data = abi.encode(listUID, target), recipient 0, refUID 0, revocable', () => {
    const target = uid(0x777)
    const plan = buildAddEntryPlan(SCHEMAS, LIST, 'any', target)
    const e = plan.attestations[0]
    expect(e?.kind).toBe('LIST_ENTRY')
    expect(e?.schema).toBe(SCHEMAS.listEntry)
    expect(e?.revocable).toBe(true)
    expect(e?.refUID).toBe(ZERO_UID) // refUID MUST be 0 (UsesRefUID)
    expect(e?.recipient).toBe(ZERO_ADDR) // ANY requires recipient 0
    expect(e?.data).toBe(listEntryEnc.encodeData([LIST, target]))
  })

  it('SCHEMA: encodes the target attestation UID in the payload, recipient 0', () => {
    const target = uid(0x888)
    const plan = buildAddEntryPlan(SCHEMAS, LIST, 'schema', target)
    const e = plan.attestations[0]
    expect(e?.recipient).toBe(ZERO_ADDR)
    expect(e?.data).toBe(listEntryEnc.encodeData([LIST, target]))
  })

  it('ADDR: member rides in recipient, payload target forced to bytes32(0)', () => {
    const member = addr(0xbeef)
    const plan = buildAddEntryPlan(SCHEMAS, LIST, 'addr', member)
    const e = plan.attestations[0]
    expect(e?.recipient).toBe(member) // ADDR — member in recipient
    expect(e?.data).toBe(listEntryEnc.encodeData([LIST, ZERO_UID])) // payload target = 0
    // sanity: the encoded payload target decodes to zero
    const [decodedList, decodedTarget] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      e?.data as Hex,
    ) as [Hex, Hex]
    expect(decodedList).toBe(LIST)
    expect(decodedTarget).toBe(ZERO_UID)
  })

  it('ADDR: address(0) is an explicitly-valid member (recipient = 0)', () => {
    const plan = buildAddEntryPlan(SCHEMAS, LIST, 'addr', ZERO_ADDR)
    const e = plan.attestations[0]
    expect(e?.recipient).toBe(ZERO_ADDR)
    expect(e?.data).toBe(listEntryEnc.encodeData([LIST, ZERO_UID]))
  })
})

describe('validateAddTarget', () => {
  it('ADDR accepts a 20-byte address, including address(0)', () => {
    expect(validateAddTarget('addr', addr(0x1))).toBe(addr(0x1))
    expect(validateAddTarget('addr', ZERO_ADDR)).toBe(ZERO_ADDR)
  })

  it('ADDR rejects a 32-byte UID', () => {
    expect(() => validateAddTarget('addr', uid(0x1))).toThrow(InvalidListConfig)
  })

  it('ANY/SCHEMA accept a nonzero 32-byte UID', () => {
    expect(validateAddTarget('any', uid(0x5))).toBe(uid(0x5))
    expect(validateAddTarget('schema', uid(0x5))).toBe(uid(0x5))
  })

  it('ANY/SCHEMA reject a zero UID', () => {
    expect(() => validateAddTarget('any', ZERO_UID)).toThrow(/NONZERO/i)
    expect(() => validateAddTarget('schema', ZERO_UID)).toThrow(/NONZERO/i)
  })

  it('ANY/SCHEMA reject a 20-byte address (wrong width)', () => {
    expect(() => validateAddTarget('schema', addr(0x1))).toThrow(InvalidListConfig)
  })
})

// ── Mock chain for the submit path ──────────────────────────────────────────────

function attestedLog(schema: Hex, mintedUID: Hex, recipient: Address, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: attestedEventAbi,
    eventName: 'Attested',
    args: { recipient, attester: ATTESTER, schemaUID: schema },
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

/** A mock submit context recording each layer's multiAttest requests. `mintUID`
 * controls the UID the (single) minted attestation gets — so create can assert the
 * returned listUID. */
function makeSubmitCtx(mintUID: Hex = uid(0xd000)): {
  ctx: EdgeSubmitContext
  calls: {
    schema: Hex
    data: { recipient: Address; refUID: Hex; data: Hex; revocable: boolean }[]
  }[][]
} {
  let callIndex = 0
  const receipts = new Map<Hex, TransactionReceipt>()
  const calls: {
    schema: Hex
    data: { recipient: Address; refUID: Hex; data: Hex; revocable: boolean }[]
  }[][] = []
  const walletClient = {
    async writeContract(args: {
      args: readonly [
        readonly {
          schema: Hex
          data: readonly { recipient: Address; refUID: Hex; data: Hex; revocable: boolean }[]
        }[],
      ]
    }) {
      callIndex += 1
      const txHash = uid(callIndex)
      const layer = args.args[0].map((r) => ({ schema: r.schema, data: [...r.data] }))
      calls.push(layer)
      const entries: { schema: Hex; recipient: Address }[] = []
      for (const r of args.args[0])
        for (const d of r.data) entries.push({ schema: r.schema, recipient: d.recipient })
      const logs = entries.map((e, i) => attestedLog(e.schema, mintUID, e.recipient, i))
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

/** A ReadContext whose publicClient resolves `getMode` (the list config read). */
function readContextFor(mode: {
  exists: boolean
  curator?: Address
  allowsDuplicates?: boolean
  appendOnly?: boolean
  targetType?: number
  targetSchema?: Hex
  maxEntries?: bigint
}) {
  return () =>
    ({
      publicClient: {
        async readContract(a: { functionName: string }) {
          if (a.functionName === 'getMode') {
            return {
              exists: mode.exists,
              curator: mode.curator ?? ATTESTER,
              allowsDuplicates: mode.allowsDuplicates ?? false,
              appendOnly: mode.appendOnly ?? false,
              targetType: mode.targetType ?? 0,
              targetSchema: mode.targetSchema ?? ZERO_UID,
              maxEntries: mode.maxEntries ?? 0n,
            }
          }
          return ZERO_UID
        },
      },
      deployment,
      account: ATTESTER,
    }) as never
}

// ── lists write namespace ────────────────────────────────────────────────────────

describe('makeListsWriteNs.create', () => {
  it('mints a LIST and returns the receipt + listUID (one signature)', async () => {
    const LIST_UID = uid(0xabc1)
    const { ctx, calls } = makeSubmitCtx(LIST_UID)
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true }),
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    const out = await lists.create({
      allowsDuplicates: false,
      appendOnly: false,
      targetType: 'any',
    })
    expect(out.signatureCount).toBe(1)
    expect(out.listUID).toBe(LIST_UID)
    expect(calls).toHaveLength(1)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.revocable).toBe(false)
    expect(entry?.refUID).toBe(ZERO_UID)
    expect(entry?.recipient).toBe(ZERO_ADDR)
  })

  it('rejects an invalid config before submit (no chain round-trip)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true }),
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    await expect(
      lists.create({ allowsDuplicates: false, appendOnly: false, targetType: 'schema' }),
    ).rejects.toBeInstanceOf(InvalidListConfig)
    expect(calls).toHaveLength(0) // never submitted
  })
})

describe('makeListsWriteNs.add', () => {
  const LIST = uid(0x500)

  it('routes ANY by reading the list config; submits one entry (one sig)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const target = uid(0x777)
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true, targetType: 0 }), // ANY
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    const receipt = await lists.add(LIST, target)
    expect(receipt.signatureCount).toBe(1)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.recipient).toBe(ZERO_ADDR)
    expect(entry?.data).toBe(listEntryEnc.encodeData([LIST, target]))
  })

  it('routes SCHEMA from the config (recipient 0, target UID in payload)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const target = uid(0x888)
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true, targetType: 2, targetSchema: uid(0x999) }),
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    await lists.add(LIST, target)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.recipient).toBe(ZERO_ADDR)
    expect(entry?.data).toBe(listEntryEnc.encodeData([LIST, target]))
  })

  it('routes ADDR: member in recipient, payload target zero', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const member = addr(0xbeef)
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true, targetType: 1 }), // ADDR
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    await lists.add(LIST, member)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.recipient).toBe(member)
    expect(entry?.data).toBe(listEntryEnc.encodeData([LIST, ZERO_UID]))
  })

  it('ADDR accepts address(0)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true, targetType: 1 }),
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    await lists.add(LIST, ZERO_ADDR)
    const entry = calls[0]?.[0]?.data[0]
    expect(entry?.recipient).toBe(ZERO_ADDR)
    expect(entry?.data).toBe(listEntryEnc.encodeData([LIST, ZERO_UID]))
  })

  it('honors an explicit targetType hint (skips the config read)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    let readCount = 0
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: () =>
        ({
          publicClient: {
            async readContract() {
              readCount += 1
              return ZERO_UID
            },
          },
          deployment,
          account: ATTESTER,
        }) as never,
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    await lists.add(LIST, uid(0x777), { targetType: 'any' })
    expect(readCount).toBe(0) // no config read with the hint
    expect(calls).toHaveLength(1)
  })

  it('rejects a target whose shape mismatches the mode (before submit)', async () => {
    const { ctx, calls } = makeSubmitCtx()
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true, targetType: 1 }), // ADDR
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    // ADDR list but a 32-byte UID target → rejected.
    await expect(lists.add(LIST, uid(0x777))).rejects.toBeInstanceOf(InvalidListConfig)
    expect(calls).toHaveLength(0)
  })

  it('throws ListNotFound when no LIST exists at the UID', async () => {
    const { ctx } = makeSubmitCtx()
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: false }),
      submitContext: () => ctx,
      revoke: async () => uid(0),
    })
    await expect(lists.add(LIST, uid(0x777))).rejects.toBeInstanceOf(ListNotFound)
  })
})

describe('makeListsWriteNs.remove', () => {
  const ENTRY = uid(0xabc)
  const LIST = uid(0x500)

  it('revokes the entry under the listEntry schema (no listUID hint)', async () => {
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true }),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async (schema, u) => {
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
    })
    const tx = await lists.remove(ENTRY)
    expect(tx).toBe(uid(0xfee))
    expect(revokeCall).toEqual({ schema: SCHEMAS.listEntry, uid: ENTRY })
  })

  it('rejects up front when the list is append-only (with a listUID hint)', async () => {
    let revoked = false
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true, appendOnly: true }),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async () => {
        revoked = true
        return uid(0xfee)
      },
    })
    await expect(lists.remove(ENTRY, { listUID: LIST })).rejects.toBeInstanceOf(ListAppendOnly)
    expect(revoked).toBe(false) // no chain round-trip
  })

  it('allows removal of a revocable list (with a listUID hint)', async () => {
    let revokeCall: { schema: Hex; uid: Hex } | undefined
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: true, appendOnly: false }),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async (schema, u) => {
        revokeCall = { schema, uid: u }
        return uid(0xfee)
      },
    })
    await lists.remove(ENTRY, { listUID: LIST })
    expect(revokeCall).toEqual({ schema: SCHEMAS.listEntry, uid: ENTRY })
  })

  it('throws ListNotFound when the hinted list does not exist', async () => {
    const lists = makeListsWriteNs({
      getDeployment: () => deployment,
      publicClient: { async readContract() {} } as never,
      readContext: readContextFor({ exists: false }),
      submitContext: () => makeSubmitCtx().ctx,
      revoke: async () => uid(0xfee),
    })
    await expect(lists.remove(ENTRY, { listUID: LIST })).rejects.toBeInstanceOf(ListNotFound)
  })
})
