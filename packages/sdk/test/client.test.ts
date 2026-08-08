/**
 * Unit tests for `createEfsClient` driven through a mock EIP-1193 provider —
 * the SDK's standard boundary (ADR-0009). These exercise the freeze-independent
 * client paths:
 *   - ProviderConfig → viem-clients normalization (`resolveClients`).
 *   - Runtime write-gating: a read-only client (no wallet) throws WalletRequired;
 *     a write-capable client reaches NotImplemented.
 *   - Deployment resolution via chainId (the per-chain registry, ADR-0005) and
 *     the construct-time bytecode integrity gate.
 */

import type { Address, Chain } from 'viem'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  DeploymentNotFound,
  type DeploymentsMap,
  EFS_PROFILE_V1,
  type EfsContracts,
  type EfsDeployment,
  EfsError,
  type EfsSchemaUIDs,
  NotImplemented,
  SchemaMismatchError,
  WalletRequired,
  createEfsClient,
  createEfsV1Client,
} from '../src/index.js'
import { type MethodHandler, createMockProvider } from './helpers/mock-eip1193.js'

const CHAIN_ID = 31337

/** A minimal viem `Chain` for the mock — only `id` is read by the SDK paths. */
const localChain = {
  id: CHAIN_ID,
  name: 'Mock Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
} as const satisfies Chain

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

/** A complete contracts set, all pointed at distinct dummy addresses. */
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
  anchor: '0x01',
  property: '0x02',
  data: '0x03',
  pin: '0x04',
  tag: '0x05',
  mirror: '0x06',
  list: '0x07',
  listEntry: '0x08',
  redirect: '0x09',
}

const deployment: EfsDeployment = { chainId: CHAIN_ID, contracts, schemas }
const deployments: DeploymentsMap = { [CHAIN_ID]: deployment }

describe('createEfsClient — ProviderConfig normalization (EIP-1193 boundary)', () => {
  it('builds a read-only client from a provider with no account', async () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain })
    // The read namespaces exist; the read verb is wired. Without a `deployments`
    // override for this chain it reaches deployment resolution → DeploymentNotFound
    // (proving it's wired, no longer the NotImplemented stub).
    expect(typeof efs.lenses.lens).toBe('function')
    await expect(efs.fs.read('/x')).rejects.toThrow(DeploymentNotFound)
  })

  it('builds a write-capable client when an account is supplied', async () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, account: addr(99) })
    // `write` is present and wired (Tier-1): it passes the wallet gate and reaches
    // deployment resolution (DeploymentNotFound — no deployment for this chain),
    // proving it's no longer the NotImplemented stub and no longer WalletRequired.
    await expect(efs.fs.write('/x', new Uint8Array())).rejects.toThrow(DeploymentNotFound)
  })
})

describe('createEfsClient — runtime write gate', () => {
  it('a read-only client rejects writes with WalletRequired (the backstop)', async () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    // The type hides `write` on a read-only client; reach it via a cast to prove
    // the runtime guard fires before NotImplemented.
    const readOnly = createEfsClient({ provider, chain: localChain }) as unknown as {
      fs: { write(p: string, c: Uint8Array): Promise<unknown> }
      batch(): { execute(): Promise<unknown> }
    }
    await expect(readOnly.fs.write('/x', new Uint8Array())).rejects.toThrow(WalletRequired)
    // The batch entrypoint is gated the same way.
    expect(() => readOnly.batch()).toThrow(WalletRequired)
  })

  it('a walletClient with no bound account rejects fs.write with WalletRequired', async () => {
    // The wallet is present (passes the top-level gate) but has no `account`, so the
    // attester would default to 0x0 — EFS lenses + the receipt key on the real attester,
    // so writeFileTier1 must fail closed. A chain-bearing publicClient + `deployments`
    // gets the write context built and reaching that guard.
    const make = createEfsClient as unknown as (c: unknown) => {
      fs: { write(p: string, c: Uint8Array): Promise<unknown> }
    }
    const efs = make({
      publicClient: { chain: { id: CHAIN_ID } },
      walletClient: {}, // present, but no bound account
      deployments,
    })
    await expect(efs.fs.write('/x', new Uint8Array([1]))).rejects.toThrow(WalletRequired)
  })

  it('rejects fs.write with WrongChain when the wallet is on a different chain than the deployment', async () => {
    // Public client on CHAIN_ID (deployment resolves there), but the wallet's LIVE chain
    // is different — writes would target the wrong chain's contracts. Fail closed BEFORE
    // any tx, using the live getChainId (NOT the possibly-stale bound `chain`).
    const make = createEfsClient as unknown as (c: unknown) => {
      fs: { write(p: string, c: Uint8Array): Promise<unknown> }
    }
    const efs = make({
      publicClient: { chain: { id: CHAIN_ID } },
      // Bound `chain` is STALE-matching (CHAIN_ID), but the LIVE getChainId reports a
      // different network — the guard must trust the live value (an injected wallet that
      // switched networks). The old bound-chain shortcut would have wrongly passed.
      walletClient: {
        account: { address: addr(7) },
        chain: { id: CHAIN_ID },
        getChainId: async () => 1,
      },
      deployments,
    })
    const err = await efs.fs.write('/x', new Uint8Array([1])).catch((e) => e)
    expect(err).toBeInstanceOf(EfsError)
    expect((err as EfsError).code).toBe('WrongChain')
    expect((err as Error).message).toMatch(/chain 1\b.*chain 31337|wrong chain/i)
  })

  it('rejects a STANDALONE write (graph.pins.place) with WrongChain on a mismatched wallet', async () => {
    // The wrong-chain guard must also cover the standalone verbs (props/tags/pins/
    // mirrors/redirects/lists) that share the edge submit context — not just fs.write.
    const make = createEfsClient as unknown as (c: unknown) => {
      graph: { pins: { place(anchor: string, data: string): Promise<unknown> } }
    }
    const efs = make({
      publicClient: { chain: { id: CHAIN_ID } },
      // Bound `chain` is STALE-matching (CHAIN_ID), but the LIVE getChainId reports a
      // different network — the guard must trust the live value (an injected wallet that
      // switched networks). The old bound-chain shortcut would have wrongly passed.
      walletClient: {
        account: { address: addr(7) },
        chain: { id: CHAIN_ID },
        getChainId: async () => 1,
      },
      deployments,
    })
    // place() takes bytes32 anchor + DATA UIDs; the guard fires before the tx.
    const b32 = (h: string) => `0x${h.repeat(64).slice(0, 64)}` as `0x${string}`
    const err = await efs.graph.pins.place(b32('a'), b32('d')).catch((e) => e)
    expect(err).toBeInstanceOf(EfsError)
    expect((err as EfsError).code).toBe('WrongChain')
  })

  it('rejects a REVOKE/remove (graph.tags.remove + eas.revoke) with WrongChain on a mismatched wallet', async () => {
    // The remove/revoke path bypasses edgeSubmitContext and routes through easVerbs.revoke
    // — it must run the same chain guard, else a wrong-chain wallet could send a no-op /
    // wrong-chain EAS revoke while the deployment-chain attestation stays active.
    const make = createEfsClient as unknown as (c: unknown) => {
      graph: { tags: { remove(uid: string): Promise<unknown> } }
      eas: { revoke(r: { schema: string; uid: string }): Promise<unknown> }
    }
    const efs = make({
      publicClient: { chain: { id: CHAIN_ID } },
      // Bound `chain` is STALE-matching (CHAIN_ID), but the LIVE getChainId reports a
      // different network — the guard must trust the live value (an injected wallet that
      // switched networks). The old bound-chain shortcut would have wrongly passed.
      walletClient: {
        account: { address: addr(7) },
        chain: { id: CHAIN_ID },
        getChainId: async () => 1,
      },
      deployments,
    })
    const b32 = (h: string) => `0x${h.repeat(64).slice(0, 64)}` as `0x${string}`
    const removeErr = await efs.graph.tags.remove(b32('e')).catch((e) => e)
    expect(removeErr).toBeInstanceOf(EfsError)
    expect((removeErr as EfsError).code).toBe('WrongChain')
    // The raw escape-hatch revoke is guarded too (covers efs.eas.attest/multiAttest).
    const easErr = await efs.eas.revoke({ schema: b32('5'), uid: b32('e') }).catch((e) => e)
    expect((easErr as EfsError).code).toBe('WrongChain')
  })

  it('a write client wires write (Tier-1) and still stubs batch', async () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, account: addr(1) })
    // write is wired: passes the wallet gate, reaches deployment resolution.
    await expect(efs.fs.write('/x', new Uint8Array())).rejects.toThrow(DeploymentNotFound)
    // batch is still the NotImplemented stub (a later slice).
    expect(() => efs.batch()).toThrow(NotImplemented)
  })
})

describe('createEfsClient — deployment resolution via chainId (ADR-0005)', () => {
  it('resolves the deployment from the chain id via the override registry', () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    const resolved = efs.raw.deployment()
    expect(resolved.chainId).toBe(CHAIN_ID)
    expect(resolved.contracts.eas).toBe(addr(1))
  })

  it('throws DeploymentNotFound for a chain with no registered deployment', () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    // No override and the built-in registry is empty pre-launch.
    const efs = createEfsClient({ provider, chain: localChain })
    expect(() => efs.raw.deployment()).toThrow(DeploymentNotFound)
  })

  // The nine schema-UID getter selectors → the deployment key each authenticates.
  // verifyDeployment reads each from its authoritative on-chain getter and asserts
  // the value matches `deployment.schemas` (review P1 #9). Returning the *matching*
  // UID makes the schema gate pass; the bytecode-absent / mismatch cases below
  // exercise the two failure modes.
  const SCHEMA_SELECTORS: Record<string, keyof EfsSchemaUIDs> = {
    '0x1fc47af2': 'anchor',
    '0x069745bc': 'property',
    '0xc719acf0': 'data',
    '0xbb9ca7cc': 'pin',
    '0x9f5cd3ab': 'tag',
    '0x32d1163e': 'mirror',
    '0xe64bb23e': 'list',
    '0xfab5c5eb': 'listEntry',
    '0xc135da58': 'redirect',
  }
  const pad32 = (h: string) => `0x${h.replace(/^0x/, '').padStart(64, '0')}`
  /** Answer a schema-UID `eth_call` with the deployment's claimed UID (a match). */
  const matchingSchemaCall: MethodHandler = (params) => {
    const data = String((params[0] as { data?: string })?.data ?? '')
    const key = SCHEMA_SELECTORS[data.slice(0, 10)]
    return key ? pad32(deployment.schemas[key]) : '0x'
  }
  /** Give every contract address some bytecode so the presence gate passes. */
  const allCode = (): Record<string, string> => {
    const code: Record<string, string> = {}
    for (const a of Object.values(contracts)) code[a.toLowerCase()] = '0x60006000'
    return code
  }

  it('verifyDeployment passes when bytecode is present and schema UIDs match', async () => {
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      code: allCode(),
      handlers: { eth_call: matchingSchemaCall },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    await expect(efs.raw.verifyDeployment()).resolves.toBeUndefined()
    // The presence gate probed each contract via eth_getCode...
    expect(provider.callCount('eth_getCode')).toBe(Object.keys(contracts).length)
    // ...and the schema gate read all nine UIDs via eth_call.
    expect(provider.callCount('eth_call')).toBe(9)
  })

  it('verifyDeployment throws when a contract address has no bytecode', async () => {
    // Default mock returns '0x' (no code) for every address → first probe fails
    // (bytecode runs before any schema read).
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    await expect(efs.raw.verifyDeployment()).rejects.toThrow(EfsError)
    expect(provider.callCount('eth_call')).toBe(0)
  })

  it('verifyDeployment throws SchemaMismatchError when an on-chain UID differs', async () => {
    const wrongData: MethodHandler = (params) => {
      const data = String((params[0] as { data?: string })?.data ?? '')
      // The DATA getter reports a UID that disagrees with the deployment claim.
      if (data.startsWith('0xc719acf0')) return pad32('0xdead')
      return matchingSchemaCall(params)
    }
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      code: allCode(),
      handlers: { eth_call: wrongData },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    await expect(efs.raw.verifyDeployment()).rejects.toThrow(SchemaMismatchError)
  })

  it('verifyDeployment guards a post-resolution chain switch (TOCTOU → WrongChain)', async () => {
    // liveDeployment() resolves at eth_chainId call 1; verifyDeployment's getCode/schema probes
    // run after. A provider that drifts in between would verify the resolved chain's addresses
    // against the new chain (or falsely pass on a fork with matching addresses). The probe now
    // runs through a client guarded to the resolved chain → fails closed on drift. Code +
    // schemas are set up to PASS absent drift, isolating the guard as the cause of the throw.
    let chainIdCalls = 0
    const provider = createMockProvider({
      chainId: CHAIN_ID,
      code: allCode(),
      handlers: {
        eth_call: matchingSchemaCall,
        eth_chainId: () => {
          chainIdCalls += 1
          return chainIdCalls === 1 ? `0x${CHAIN_ID.toString(16)}` : '0xf423f' // CHAIN_ID then 999999
        },
      },
    })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    const err = await efs.raw.verifyDeployment().catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
  })
})

// ── The v1 profile boundary (ADR-0019/R1) ───────────────────────────────────────

describe('the v1 profile boundary (ADR-0019)', () => {
  it('createEfsV1Client is the canonical factory; the client carries the profile discriminant', () => {
    const provider = createMockProvider({ chainId: 31337 })
    const efs = createEfsV1Client({ provider, chain: localChain })
    expect(efs.profile).toBe('efs/v1')
    expect(EFS_PROFILE_V1).toBe('efs/v1')
  })

  it('createEfsClient is the SAME function (deprecated one-cycle alias)', () => {
    expect(createEfsClient).toBe(createEfsV1Client)
  })

  it('a write receipt carries the profile stamp and the separated roles (one EOA fills all on Tier-1)', async () => {
    // Shape-level pin via the edge path's receipt (cheapest end-to-end): covered
    // behaviorally in writes-edge/file-write suites; here pin the TYPE contract.
    expectTypeOf<WriteReceipt['profile']>().toEqualTypeOf<'efs/v1'>()
    expectTypeOf<WriteReceipt['roles']>().toEqualTypeOf<WriteRoles>()
    expectTypeOf<DataRef['profile']>().toEqualTypeOf<'efs/v1'>()
  })
})
