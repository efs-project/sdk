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
import { describe, expect, it } from 'vitest'
import {
  DeploymentNotFound,
  type DeploymentsMap,
  type EfsContracts,
  type EfsDeployment,
  EfsError,
  type EfsSchemaUIDs,
  NotImplemented,
  WalletRequired,
  createEfsClient,
} from '../src/index.js'
import { createMockProvider } from './helpers/mock-eip1193.js'

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
  aliasResolver: addr(10),
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
    // The read namespaces exist; the read verb is shaped but not implemented yet.
    expect(typeof efs.lenses.lens).toBe('function')
    await expect(efs.fs.read('/x')).rejects.toThrow(NotImplemented)
  })

  it('builds a write-capable client when an account is supplied', async () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, account: addr(99) })
    // `write` is present and reaches NotImplemented (not WalletRequired).
    await expect(efs.fs.write('/x', new Uint8Array())).rejects.toThrow(NotImplemented)
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

  it('a write client reaches NotImplemented for write and batch', async () => {
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, account: addr(1) })
    await expect(efs.fs.write('/x', new Uint8Array())).rejects.toThrow(NotImplemented)
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

  it('verifyDeployment passes when every contract address has bytecode', async () => {
    // Give every contract address some bytecode so the integrity gate passes.
    const code: Record<string, string> = {}
    for (const a of Object.values(contracts)) code[a.toLowerCase()] = '0x60006000'
    const provider = createMockProvider({ chainId: CHAIN_ID, code })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    await expect(efs.raw.verifyDeployment()).resolves.toBeUndefined()
    // The gate probed each contract via eth_getCode.
    expect(provider.callCount('eth_getCode')).toBe(Object.keys(contracts).length)
  })

  it('verifyDeployment throws when a contract address has no bytecode', async () => {
    // Default mock returns '0x' (no code) for every address → first probe fails.
    const provider = createMockProvider({ chainId: CHAIN_ID })
    const efs = createEfsClient({ provider, chain: localChain, deployments })
    await expect(efs.raw.verifyDeployment()).rejects.toThrow(EfsError)
  })
})
