/**
 * The write-execution seam (sdk-wallet-architecture): `detectAccount`,
 * `selectSingle`, and the `Tier1Submitter` receipt stamping. Pure / mock-client —
 * no live chain. Behavior must stay Tier-1-identical; these lock the seam shape so
 * the deferred AA work plugs in without a regression.
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
import type { EfsSchemaUIDs } from '../src/chain/deployments.js'
import { hashContent } from '../src/content/hash.js'
import { attestedEventAbi } from '../src/eas/abi.js'
import type { AccountProfile } from '../src/types.js'
import {
  type DetectClient,
  detectAccount,
  invalidateAccountProfile,
  kindFromCode,
  toCapabilities,
  unwrapCapabilities,
} from '../src/writes/detect.js'
import { buildFileWriteGraph } from '../src/writes/graph.js'
import { selectSingle } from '../src/writes/select.js'
import { type SubmitterContext, Tier1Submitter } from '../src/writes/submitter.js'

const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address

// ── kindFromCode (getCode discrimination) ──────────────────────────────────────

describe('kindFromCode', () => {
  it('classifies an empty/0x code as a plain EOA', () => {
    expect(kindFromCode('0x')).toBe('eoa')
    expect(kindFromCode(undefined)).toBe('eoa')
  })

  it('classifies a 0xef0100‖impl designator as a 7702-delegated EOA', () => {
    const impl = addr(0xbeef).slice(2)
    expect(kindFromCode(`0xef0100${impl}` as Hex)).toBe('eoa-7702-delegated')
    // case-insensitive on the prefix
    expect(kindFromCode(`0xEF0100${impl}` as Hex)).toBe('eoa-7702-delegated')
  })

  it('classifies any other bytecode as a smart account', () => {
    expect(kindFromCode('0x60806040' as Hex)).toBe('smart-account')
  })
})

// ── unwrapCapabilities (nested-cap unwrap + missing-cap tolerance) ──────────────

describe('unwrapCapabilities', () => {
  const CHAIN = 11155111 // Sepolia

  it('unwraps the nested atomic.status + paymasterService.supported, hex chain key', () => {
    const raw = {
      [`0x${CHAIN.toString(16)}`]: {
        atomic: { status: 'ready' },
        paymasterService: { supported: true },
      },
    }
    expect(unwrapCapabilities(raw, CHAIN)).toEqual({
      batchExecution: { atomic: 'ready' },
      sponsorable: true,
    })
  })

  it('accepts a numeric chain key too', () => {
    const raw = { [String(CHAIN)]: { atomic: { status: 'supported' } } }
    expect(unwrapCapabilities(raw, CHAIN)).toEqual({
      batchExecution: { atomic: 'supported' },
      sponsorable: false,
    })
  })

  it('tolerates a wallet that returned nothing (no caps for the chain)', () => {
    expect(unwrapCapabilities(undefined, CHAIN)).toEqual({ sponsorable: false })
    expect(unwrapCapabilities({}, CHAIN)).toEqual({ sponsorable: false })
    expect(unwrapCapabilities({ '0x1': { atomic: { status: 'ready' } } }, CHAIN)).toEqual({
      sponsorable: false,
    })
  })

  it('omits batchExecution when atomic.status is absent but keeps sponsorable', () => {
    const raw = { [String(CHAIN)]: { paymasterService: { supported: true } } }
    expect(unwrapCapabilities(raw, CHAIN)).toEqual({ sponsorable: true })
  })
})

// ── detectAccount (kind + caps + missing-cap tolerance + caching) ───────────────

describe('detectAccount', () => {
  const CHAIN = 11155111
  const ADDR = addr(0xa11ce)

  it('derives kind from getCode and caps from getCapabilities', async () => {
    const client: DetectClient = {
      getCode: async () => '0x' as Hex,
      getCapabilities: async () => ({
        [`0x${CHAIN.toString(16)}`]: {
          atomic: { status: 'ready' },
          paymasterService: { supported: true },
        },
      }),
    }
    const profile = await detectAccount(client, ADDR, CHAIN)
    expect(profile.kind).toBe('eoa')
    expect(profile.batchExecution).toEqual({ atomic: 'ready' })
    expect(profile.sponsorable).toBe(true)
    // No in-account adapter yet — never one-sig today.
    expect(profile.canRunInAccountRoutine).toBe(false)
    invalidateAccountProfile(ADDR, CHAIN)
  })

  it('tolerates a wallet without getCapabilities (→ undefined batchExecution)', async () => {
    const code = `0xef0100${addr(0xbeef).slice(2)}` as Hex
    const client: DetectClient = { getCode: async () => code }
    const profile = await detectAccount(client, addr(0xb0b), CHAIN)
    expect(profile.kind).toBe('eoa-7702-delegated')
    expect(profile.batchExecution).toBeUndefined()
    expect(profile.sponsorable).toBe(false)
    invalidateAccountProfile(addr(0xb0b), CHAIN)
  })

  it('tolerates a getCapabilities that throws (plain EOA wallet)', async () => {
    const client: DetectClient = {
      getCode: async () => '0x' as Hex,
      getCapabilities: async () => {
        throw new Error('wallet_getCapabilities not supported')
      },
    }
    const profile = await detectAccount(client, addr(0xc0de), CHAIN)
    expect(profile.kind).toBe('eoa')
    expect(profile.batchExecution).toBeUndefined()
    invalidateAccountProfile(addr(0xc0de), CHAIN)
  })

  it('caches per (address, chainId) — one getCode call across repeats', async () => {
    let codeCalls = 0
    const client: DetectClient = {
      getCode: async () => {
        codeCalls += 1
        return '0x' as Hex
      },
    }
    const a = await detectAccount(client, addr(0xca11), CHAIN)
    const b = await detectAccount(client, addr(0xca11), CHAIN)
    expect(a).toBe(b)
    expect(codeCalls).toBe(1)
    invalidateAccountProfile(addr(0xca11), CHAIN)
  })
})

// ── toCapabilities (curated public projection) ──────────────────────────────────

describe('toCapabilities', () => {
  it('projects to the curated view without leaking internals', () => {
    const profile: AccountProfile = {
      address: addr(0x1),
      kind: 'smart-account',
      batchExecution: { atomic: 'ready' },
      sponsorable: true,
      canRunInAccountRoutine: false,
      raw: { some: 'blob' },
    }
    expect(toCapabilities(profile)).toEqual({
      kind: 'smart-account',
      canOneSig: false,
      gasless: true,
      sponsored: true,
    })
  })
})

// ── selectSingle (returns Tier-1 today) ─────────────────────────────────────────

describe('selectSingle', () => {
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
  const plan = buildFileWriteGraph({
    path: '/a.txt',
    content: { kind: 'bytes', bytes: new Uint8Array([1]) },
    mirrors: ['ipfs://Qm'],
    contentHash: uid(0x300),
    size: 1n,
    schemas: SCHEMAS,
    transportDefinition: uid(0x200),
    parentAnchorUID: uid(0x100),
    fileName: 'a.txt',
  })

  const base: Omit<AccountProfile, 'kind' | 'canRunInAccountRoutine'> = {
    address: addr(0x1),
    sponsorable: false,
  }

  it('returns the Tier-1 submitter for a plain EOA', () => {
    const submitter = selectSingle({ ...base, kind: 'eoa', canRunInAccountRoutine: false }, plan)
    expect(submitter).toBe(Tier1Submitter)
    expect(submitter.mechanism).toBe('sequential')
  })

  it('returns Tier-1 even for a capable account today (no in-account adapter)', () => {
    // The ladder structure exists; with no adapter wired, every account → Tier-1.
    const submitter = selectSingle(
      { ...base, kind: 'eoa-7702-delegated', sponsorable: true, canRunInAccountRoutine: false },
      plan,
    )
    expect(submitter).toBe(Tier1Submitter)
  })
})

// ── Tier1Submitter receipt (reason + gasless stamping) ──────────────────────────

describe('Tier1Submitter receipt', () => {
  const SCHEMAS: EfsSchemaUIDs = {
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
  const EAS = addr(0xea51)
  const ATTESTER = addr(0xacc01)

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

  /** Mock chain: each layer's multiAttest mints one Attested per entry, in order. */
  function makeCtx(): SubmitterContext {
    let globalIndex = 0
    let callIndex = 0
    const receipts = new Map<Hex, TransactionReceipt>()
    const walletClient = {
      async writeContract(args: {
        args: readonly [readonly { schema: Hex; data: readonly unknown[] }[]]
      }) {
        callIndex += 1
        const txHash = uid(callIndex)
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
      walletClient: walletClient as unknown as SubmitterContext['walletClient'],
      publicClient: publicClient as unknown as SubmitterContext['publicClient'],
      easAddress: EAS,
      contentHash: hashContent(new Uint8Array([1, 2, 3])),
      chainId: 11155111,
      attester: ATTESTER,
      account: ATTESTER,
    }
  }

  it('stamps mechanism/gasless/reason for the Tier-1 path', async () => {
    const plan = buildFileWriteGraph({
      path: '/docs/readme.md',
      content: { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) },
      mirrors: ['ipfs://Qm'],
      contentHash: uid(0x300),
      size: 3n,
      schemas: SCHEMAS,
      transportDefinition: uid(0x200),
      parentAnchorUID: uid(0x100),
      fileName: 'readme.md',
    })

    const receipt = await Tier1Submitter.submit(plan, makeCtx())

    expect(receipt.mechanism).toBe('sequential')
    expect(receipt.status).toBe('confirmed')
    expect(receipt.gasless).toBe(false)
    expect(receipt.reason).toEqual({
      selected: 'sequential',
      why: 'dependent-dag-needs-sequential',
    })
    expect(receipt.signatureCount).toBeGreaterThan(0)
    // The DATA ref carries the chain + attester from the context.
    expect(receipt.data?.chainId).toBe(11155111)
    expect(receipt.data?.resolvedBy).toBe(ATTESTER)
  })
})
