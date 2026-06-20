/**
 * Unit tests for the `efs.raw` / `efs.eas` / `efs.decode` escape hatches (P1-4).
 *
 *   - `efs.raw.*` pre-wired contract instances bind to the right address + ABI and
 *     carry `.write.*` only when a wallet is present.
 *   - `efs.eas.attest`/`revoke` call through `writeContract` with a wallet and throw
 *     `WalletRequired` without one; `getAttestation` reads always.
 *   - `efs.decode` round-trips a known schema and passes an unknown schema through.
 */

import {
  type Address,
  type Chain,
  type Hex,
  createPublicClient,
  custom,
  encodeAbiParameters,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
  type Attestation,
  type DeploymentsMap,
  type EfsContracts,
  type EfsDeployment,
  type EfsSchemaUIDs,
  WalletRequired,
  buildRawContracts,
  createEfsClient,
  decodeAttestation,
} from '../src/index.js'
import { createMockProvider } from './helpers/mock-eip1193.js'

const CHAIN_ID = 31337

const localChain = {
  id: CHAIN_ID,
  name: 'Mock Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
} as const satisfies Chain

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const pad32 = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

const contracts: EfsContracts = {
  eas: addr(1),
  schemaRegistry: addr(2),
  indexer: addr(3),
  router: addr(4),
  fileView: addr(5),
  edgeResolver: addr(6),
  mirrorResolver: addr(7),
  listResolver: addr(8),
  listEntryResolver: addr(9),
  listReader: addr(10),
  aliasResolver: addr(11),
  systemAccount: addr(12),
}

const schemas: EfsSchemaUIDs = {
  anchor: pad32(0x01),
  property: pad32(0x02),
  data: pad32(0x03),
  pin: pad32(0x04),
  tag: pad32(0x05),
  mirror: pad32(0x06),
  list: pad32(0x07),
  listEntry: pad32(0x08),
  redirect: pad32(0x09),
}

const deployment: EfsDeployment = { chainId: CHAIN_ID, contracts, schemas }
const deployments: DeploymentsMap = { [CHAIN_ID]: deployment }

const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

// ── efs.raw.* pre-wired contract instances ───────────────────────────────────

describe('efs.raw.* pre-wired contract instances', () => {
  it('binds each instance to the right deployment address + exposes .read', () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, deployments })

    // Each raw instance is bound to its authoritative deployment address.
    expect(efs.raw.indexer.address).toBe(contracts.indexer)
    expect(efs.raw.router.address).toBe(contracts.router)
    expect(efs.raw.fileView.address).toBe(contracts.fileView)
    expect(efs.raw.edgeResolver.address).toBe(contracts.edgeResolver)
    expect(efs.raw.mirrorResolver.address).toBe(contracts.mirrorResolver)
    expect(efs.raw.listReader.address).toBe(contracts.listReader)
    expect(efs.raw.aliasResolver.address).toBe(contracts.aliasResolver)
    expect(efs.raw.eas.address).toBe(contracts.eas)

    // Read methods are present (the public client is always present).
    expect(typeof efs.raw.indexer.read.DATA_SCHEMA_UID).toBe('function')
    expect(typeof efs.raw.eas.read.getAttestation).toBe('function')
  })

  it('omits .write on a read-only client; exposes it with a wallet', () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const readOnly = createEfsClient({ provider, chain: localChain, deployments })
    // viem's getContract only generates `.write` when a wallet client is supplied.
    expect((readOnly.raw.eas as unknown as { write?: unknown }).write).toBeUndefined()

    const writeable = createEfsClient({
      provider,
      chain: localChain,
      deployments,
      account: addr(99),
    })
    expect(typeof writeable.raw.eas.write.attest).toBe('function')
    expect(typeof writeable.raw.eas.write.revoke).toBe('function')
  })

  it('re-resolves the deployment lazily (DeploymentNotFound at access, not construct)', () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    // No override + empty built-in registry: constructing is fine; touching raw throws.
    const efs = createEfsClient({ provider, chain: localChain })
    expect(() => efs.raw.indexer.address).toThrow(/No EFS deployment/)
  })

  it('reads through the bound instance against the right address (eth_call)', async () => {
    const seen: { to?: string }[] = []
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      handlers: {
        eth_call: (params) => {
          seen.push((params[0] as { to?: string }) ?? {})
          return pad32(0x03) // DATA_SCHEMA_UID
        },
      },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    const uid = await efs.raw.indexer.read.DATA_SCHEMA_UID()
    expect(uid).toBe(pad32(0x03))
    expect(seen[0]?.to?.toLowerCase()).toBe(contracts.indexer.toLowerCase())
  })

  it('buildRawContracts is usable standalone (binds via the deployment thunk)', () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const publicClient = createPublicClient({ chain: localChain, transport: custom(provider) })
    const raw = buildRawContracts(() => deployment, { public: publicClient, wallet: undefined })
    expect(raw.eas.address).toBe(contracts.eas)
    expect(raw.indexer.address).toBe(contracts.indexer)
  })
})

// ── efs.eas.* raw verbs ───────────────────────────────────────────────────────

describe('efs.eas.* raw verbs', () => {
  it('getAttestation reads always (read-only client) and returns undefined for absent', async () => {
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      handlers: {
        // Return the zero attestation tuple → absent.
        eth_call: () => encodeAttestation(zeroAtt()),
      },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    expect(await efs.eas.getAttestation(pad32(0xabc))).toBeUndefined()
  })

  it('getAttestation decodes a real record', async () => {
    const att = realAtt(schemas.data)
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      handlers: { eth_call: () => encodeAttestation(att) },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    const got = await efs.eas.getAttestation(att.uid)
    expect(got?.uid).toBe(att.uid)
    expect(got?.schema).toBe(att.schema)
    expect(got?.attester).toBe(att.attester)
  })

  it('attest/multiAttest/revoke throw WalletRequired without a wallet', async () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    // Cast through the write surface to reach the gated verbs on a read-only client.
    const efs = createEfsClient({ provider, chain: localChain, deployments }) as unknown as {
      eas: {
        attest(r: unknown): Promise<unknown>
        multiAttest(r: unknown): Promise<unknown>
        revoke(r: unknown): Promise<unknown>
      }
    }
    const req = {
      schema: schemas.data,
      data: {
        recipient: addr(0),
        expirationTime: 0n,
        revocable: true,
        refUID: ZERO_UID,
        data: '0x' as Hex,
      },
    }
    await expect(efs.eas.attest(req)).rejects.toThrow(WalletRequired)
    await expect(efs.eas.multiAttest([{ schema: schemas.data, data: [req.data] }])).rejects.toThrow(
      WalletRequired,
    )
    await expect(efs.eas.revoke({ schema: schemas.data, uid: pad32(0x1) })).rejects.toThrow(
      WalletRequired,
    )
  })

  it('attest calls through writeContract with a wallet (eth_sendTransaction)', async () => {
    let sent = 0
    let lastTo: string | undefined
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      handlers: {
        eth_estimateGas: () => '0x5208',
        eth_gasPrice: () => '0x1',
        eth_maxPriorityFeePerGas: () => '0x1',
        eth_getTransactionCount: () => '0x0',
        eth_sendTransaction: (params) => {
          sent++
          lastTo = (params[0] as { to?: string })?.to
          return pad32(0xdead) // tx hash
        },
        eth_call: () => '0x',
      },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments, account: addr(7) })
    const hash = await efs.eas.attest({
      schema: schemas.data,
      data: {
        recipient: addr(0),
        expirationTime: 0n,
        revocable: true,
        refUID: ZERO_UID,
        data: '0x',
      },
    })
    expect(hash).toBe(pad32(0xdead))
    expect(sent).toBe(1)
    expect(lastTo?.toLowerCase()).toBe(contracts.eas.toLowerCase())
  })

  it('revoke calls through writeContract with a wallet, targeting EAS', async () => {
    let lastTo: string | undefined
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      handlers: {
        eth_estimateGas: () => '0x5208',
        eth_gasPrice: () => '0x1',
        eth_maxPriorityFeePerGas: () => '0x1',
        eth_getTransactionCount: () => '0x0',
        eth_sendTransaction: (params) => {
          lastTo = (params[0] as { to?: string })?.to
          return pad32(0xbeef)
        },
        eth_call: () => '0x',
      },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments, account: addr(7) })
    const hash = await efs.eas.revoke({ schema: schemas.data, uid: pad32(0x123) })
    expect(hash).toBe(pad32(0xbeef))
    expect(lastTo?.toLowerCase()).toBe(contracts.eas.toLowerCase())
  })
})

// ── efs.decode round-trip bridge ──────────────────────────────────────────────

describe('efs.decode round-trip bridge', () => {
  it('decodes a known schema (TAG) into named typed fields', () => {
    // TAG = "bytes32 definition, int256 weight"
    const definition = pad32(0xfeed)
    const data = encodeAbiParameters(
      [
        { type: 'bytes32', name: 'definition' },
        { type: 'int256', name: 'weight' },
      ],
      [definition, 5n],
    )
    const att = { ...realAtt(schemas.tag), data }
    const decoded = decodeAttestation(att, deployment)
    expect(decoded.known).toBe(true)
    expect(decoded.schema).toBe('tag')
    if (decoded.schema === 'tag') {
      expect(decoded.fields.definition).toBe(definition)
      expect(decoded.fields.weight).toBe(5n)
    }
  })

  it('decodes the empty DATA schema to no fields', () => {
    const decoded = decodeAttestation({ ...realAtt(schemas.data), data: '0x' }, deployment)
    expect(decoded.schema).toBe('data')
    expect(decoded.fields).toEqual({})
  })

  it('passes an unrecognized schema through untouched', () => {
    const att = realAtt(pad32(0xff99)) // not one of the frozen nine
    const decoded = decodeAttestation(att, deployment)
    expect(decoded.known).toBe(false)
    expect(decoded.schema).toBe('unknown')
    if (decoded.schema === 'unknown') {
      expect(decoded.schemaUID).toBe(att.schema)
      expect(decoded.attestation).toBe(att) // raw record carried through, nothing lost
    }
  })

  it('efs.decode(attestation) is the sync pure path', () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    const att = realAtt(schemas.property)
    const data = encodeAbiParameters([{ type: 'string', name: 'value' }], ['hello'])
    const decoded = efs.decode({ ...att, data })
    expect(decoded.schema).toBe('property')
    if (decoded.schema === 'property') expect(decoded.fields.value).toBe('hello')
  })

  it('efs.decode(uid) reads then decodes; null when absent', async () => {
    const att = {
      ...realAtt(schemas.property),
      data: encodeAbiParameters([{ type: 'string' }], ['hi']),
    }
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      handlers: { eth_call: () => encodeAttestation(att) },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    const decoded = await efs.decode(att.uid)
    expect(decoded).not.toBeNull()
    expect(decoded?.schema).toBe('property')

    // Absent UID → the zero record → null.
    const provider2 = createMockProvider({
      chainId: CHAIN_ID,
      handlers: { eth_call: () => encodeAttestation(zeroAtt()) },
    })
    const efs2 = createEfsClient({ provider: provider2, chain: localChain, deployments })
    expect(await efs2.decode(pad32(0x999))).toBeNull()
  })
})

// ── helpers ───────────────────────────────────────────────────────────────────

function zeroAtt(): Attestation {
  return {
    uid: ZERO_UID,
    schema: ZERO_UID,
    time: 0n,
    expirationTime: 0n,
    revocationTime: 0n,
    refUID: ZERO_UID,
    recipient: addr(0),
    attester: addr(0),
    revocable: false,
    data: '0x',
  }
}

function realAtt(schema: Hex): Attestation {
  return {
    uid: pad32(0x1234),
    schema,
    time: 1_700_000_000n,
    expirationTime: 0n,
    revocationTime: 0n,
    refUID: ZERO_UID,
    recipient: addr(0xaa),
    attester: addr(0xbb),
    revocable: true,
    data: '0x',
  }
}

/** ABI-encode an `Attestation` exactly as `getAttestation` returns it on the wire. */
function encodeAttestation(att: Attestation): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'schema', type: 'bytes32' },
          { name: 'time', type: 'uint64' },
          { name: 'expirationTime', type: 'uint64' },
          { name: 'revocationTime', type: 'uint64' },
          { name: 'refUID', type: 'bytes32' },
          { name: 'recipient', type: 'address' },
          { name: 'attester', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    [
      {
        uid: att.uid,
        schema: att.schema,
        time: att.time,
        expirationTime: att.expirationTime,
        revocationTime: att.revocationTime,
        refUID: att.refUID,
        recipient: att.recipient,
        attester: att.attester,
        revocable: att.revocable,
        data: att.data,
      },
    ],
  )
}
