/**
 * Unit tests for the schema-UID integrity gate (review P1 #9) — the deployment
 * trust root. `assertSchemaIntegrity` reads each of the nine frozen schema UIDs
 * from its **authoritative** on-chain getter and asserts it matches what the
 * (possibly overridden) `deployment.schemas` map claims; `verifyDeployment`
 * chains the bytecode-presence gate in front of it.
 *
 * Driven through a stub `publicClient` whose `readContract` answers from a
 * `functionName → UID` map and whose `getCode` answers from an address set
 * (mirroring the stub style of `reads-resolve.test.ts`). No live chain.
 *
 * Source-of-truth getter mapping (ADR-0048):
 *   - anchor/property/data/pin/tag/mirror → Indexer `*_SCHEMA_UID()`
 *   - list      → ListResolver.listSchemaUID()
 *   - listEntry → ListEntryResolver.listEntrySchemaUID()
 *   - redirect  → AliasResolver.redirectSchemaUID()
 */

import type { Address, Hex, PublicClient } from 'viem'
import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { CORE_CONTRACT_KEYS, VIEW_CONTRACT_KEYS } from '../src/chain/deployments.js'
import {
  type EfsContracts,
  type EfsDeployment,
  EfsError,
  type EfsSchemaUIDs,
  SchemaMismatchError,
  assertSchemaIntegrity,
  resolveDeployment,
  verifyDeployment,
} from '../src/index.js'

const CHAIN_ID = 31337
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const uid = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

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

const deployment: EfsDeployment = { chainId: CHAIN_ID, contracts, schemas }

/** What each authoritative getter returns when the deployment is genuine. */
const ONCHAIN_TRUTH: Record<string, Hex> = {
  ANCHOR_SCHEMA_UID: schemas.anchor,
  PROPERTY_SCHEMA_UID: schemas.property,
  DATA_SCHEMA_UID: schemas.data,
  PIN_SCHEMA_UID: schemas.pin,
  TAG_SCHEMA_UID: schemas.tag,
  MIRROR_SCHEMA_UID: schemas.mirror,
  listSchemaUID: schemas.list,
  listEntrySchemaUID: schemas.listEntry,
  redirectSchemaUID: schemas.redirect,
}

/**
 * A stub public client. `readContract` answers from `uids` (keyed by
 * `functionName`); `getCode` returns bytecode for any address NOT in `noCode`.
 * Records every `readContract` functionName for assertions.
 */
function makeClient(
  uids: Record<string, Hex>,
  opts: { noCode?: Set<string> } = {},
): { client: PublicClient; reads: string[] } {
  const reads: string[] = []
  const client = {
    async readContract(args: { functionName: string }) {
      reads.push(args.functionName)
      const v = uids[args.functionName]
      if (v === undefined) throw new Error(`stub: no UID for ${args.functionName}`)
      return v
    },
    async getCode({ address }: { address: Address }) {
      return opts.noCode?.has(address.toLowerCase()) ? '0x' : '0x60006000'
    },
  } as unknown as PublicClient
  return { client, reads }
}

describe('assertSchemaIntegrity', () => {
  it('passes when every on-chain UID matches the deployment', async () => {
    const { client, reads } = makeClient(ONCHAIN_TRUTH)
    await expect(assertSchemaIntegrity(client, deployment)).resolves.toBeUndefined()
    // All nine UIDs were read, each from its own getter.
    expect(reads).toHaveLength(9)
    expect(new Set(reads)).toEqual(new Set(Object.keys(ONCHAIN_TRUTH)))
  })

  it('passes regardless of UID hex casing', async () => {
    const upper = { ...ONCHAIN_TRUTH, DATA_SCHEMA_UID: schemas.data.toUpperCase() as Hex }
    const { client } = makeClient(upper)
    await expect(assertSchemaIntegrity(client, deployment)).resolves.toBeUndefined()
  })

  it('throws SchemaMismatchError naming the schema when an Indexer UID differs', async () => {
    const wrong = { ...ONCHAIN_TRUTH, DATA_SCHEMA_UID: uid(0xbad) }
    const { client } = makeClient(wrong)
    await expect(assertSchemaIntegrity(client, deployment)).rejects.toThrow(SchemaMismatchError)
    await expect(assertSchemaIntegrity(client, deployment)).rejects.toThrow(/data:/)
    // The diff names the on-chain source and both UIDs.
    await expect(assertSchemaIntegrity(client, deployment)).rejects.toThrow(
      /Indexer\.DATA_SCHEMA_UID/,
    )
  })

  it('catches a self-derived resolver UID mismatch (listEntry → ListEntryResolver)', async () => {
    const wrong = { ...ONCHAIN_TRUTH, listEntrySchemaUID: uid(0xbeef) }
    const { client } = makeClient(wrong)
    const err = await assertSchemaIntegrity(client, deployment).catch((e) => e)
    expect(err).toBeInstanceOf(SchemaMismatchError)
    expect((err as Error).message).toMatch(/listEntry:/)
    expect((err as Error).message).toMatch(/ListEntryResolver\.listEntrySchemaUID/)
  })

  it('reports every mismatched schema in one diff (not just the first)', async () => {
    const wrong = {
      ...ONCHAIN_TRUTH,
      ANCHOR_SCHEMA_UID: uid(0x111),
      redirectSchemaUID: uid(0x222),
    }
    const { client } = makeClient(wrong)
    const err = (await assertSchemaIntegrity(client, deployment).catch((e) => e)) as Error
    expect(err.message).toMatch(/2 of 9/)
    expect(err.message).toMatch(/anchor:/)
    expect(err.message).toMatch(/redirect:/)
  })
})

describe('verifyDeployment', () => {
  it('passes when bytecode is present and all schema UIDs match', async () => {
    const { client } = makeClient(ONCHAIN_TRUTH)
    await expect(verifyDeployment(client, deployment)).resolves.toBeUndefined()
  })

  it('throws EfsError (bytecode-absent) before any schema read', async () => {
    // indexer has no code → presence gate fails first; readContract is never hit
    // (it would otherwise throw the stub error, not an EfsError).
    const { client, reads } = makeClient(ONCHAIN_TRUTH, {
      noCode: new Set([contracts.indexer.toLowerCase()]),
    })
    const err = await verifyDeployment(client, deployment).catch((e) => e)
    expect(err).toBeInstanceOf(EfsError)
    expect(err).not.toBeInstanceOf(SchemaMismatchError)
    expect(reads).toHaveLength(0)
  })

  it('throws SchemaMismatchError when bytecode is present but a UID is wrong', async () => {
    const wrong = { ...ONCHAIN_TRUTH, MIRROR_SCHEMA_UID: uid(0x999) }
    const { client } = makeClient(wrong)
    await expect(verifyDeployment(client, deployment)).rejects.toThrow(SchemaMismatchError)
  })
})

describe('assertViewRevision (view-codehash gate, ADR-0018)', () => {
  // keccak256('0x60006000') — what the stub's bytecode hashes to.
  const STUB_CODEHASH = keccak256('0x60006000')

  const pinned: EfsDeployment = {
    ...deployment,
    views: { revision: 'test-rev-1', codehash: { router: STUB_CODEHASH } },
  }

  it('passes when the live runtime codehash matches the pinned readback', async () => {
    const { client } = makeClient(ONCHAIN_TRUTH)
    await expect(verifyDeployment(client, pinned)).resolves.toBeUndefined()
  })

  it('fails with a precise diff when the view address serves DIFFERENT bytecode (the June-23 router-drift class)', async () => {
    const stale: EfsDeployment = {
      ...deployment,
      views: { revision: 'test-rev-1', codehash: { router: uid(0xbad) } },
    }
    const { client } = makeClient(ONCHAIN_TRUTH)
    const err = (await verifyDeployment(client, stale).catch((e) => e)) as Error
    expect(err).toBeInstanceOf(EfsError)
    expect(err.message).toMatch(/view-revision check failed/)
    expect(err.message).toMatch(/router/)
    expect(err.message).toMatch(/test-rev-1/)
  })

  it('is skipped entirely when no codehashes are recorded (override back-compat, zero extra reads)', async () => {
    const calls: string[] = []
    const { client } = makeClient(ONCHAIN_TRUTH)
    const inner = client.getCode?.bind(client)
    ;(client as { getCode: (a: { address: Address }) => Promise<string> }).getCode = async (a) => {
      calls.push(a.address.toLowerCase())
      return inner ? ((await inner(a)) as string) : '0x60006000'
    }
    await verifyDeployment(client, deployment) // no `views` on the base fixture
    // Only the presence gate's 12 getCode calls — none from the view gate.
    expect(calls).toHaveLength(Object.keys(contracts).length)
  })
})

describe('built-in registry — Sepolia (11155111)', () => {
  it('resolveDeployment(11155111) returns the seeded Sepolia deployment (no override)', () => {
    const dep = resolveDeployment(11_155_111)
    expect(dep.chainId).toBe(11_155_111)
    // Canonical addresses: record precedence is hardhat artifacts + CHAINS.md
    // (ADR-0018) — the drift CI (scripts/check-deployment-drift.mjs) holds this.
    expect(dep.contracts.indexer).toBe('0xc4DeaBB482C2FA74690629eEa662efb166BD658a')
    expect(dep.contracts.eas).toBe('0xC2679fBD37d54388Ce493F1DB75320D236e1815e')
    expect(dep.contracts.aliasResolver).toBe('0xB07225842d6513239a3519ae052B5bc7EBf18996')
    // The 2026-06-23 HARDENED view trio (the P2 fix — the prior trio still has
    // bytecode, which is exactly why the codehash pins below exist).
    expect(dep.contracts.router).toBe('0x44D5F6803127B442218e9aA0481A9931444dc82c')
    expect(dep.contracts.fileView).toBe('0x76B10909Ff10b53c54387C66B083b1613E2276d3')
    expect(dep.contracts.listReader).toBe('0xCc182611B572b5C162a3D96674E821C61ac658FC')
    expect(dep.views?.revision).toBe('sepolia-views-2026-06-23')
    expect(dep.views?.codehash?.router).toMatch(/^0x[0-9a-f]{64}$/)
    // All nine frozen schema UIDs present + 32-byte.
    const schemas = dep.schemas
    expect(schemas.data).toBe('0xa3400cecc384d66d84f502fd91e56dc0321edccde9ef8e49d303ba63cc841b3c')
    expect(schemas.redirect).toBe(
      '0x5dca2fcc2c39c8629616b175a38c5e71d641b3019a3cb4ca790cc8fd32c9b8e0',
    )
    for (const uidValue of Object.values(schemas)) {
      expect(uidValue).toMatch(/^0x[0-9a-f]{64}$/)
    }
    expect(Object.keys(schemas)).toHaveLength(9)
  })

  it('core/view key split covers exactly the contract set, disjointly', () => {
    const all = [...CORE_CONTRACT_KEYS, ...VIEW_CONTRACT_KEYS].sort()
    expect(all).toEqual(Object.keys(contracts).sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it('makes NO WHITEOUT claim: no whiteout contract key, no whiteout schema UID (contracts#44 — availability is never inferred from an ABI existing)', () => {
    // Tripwire, not a gate: whoever adds WHITEOUT must read ADR-0018's feature-
    // gating rule (manifest feature-status per chain, optional keys, typed
    // unavailable error) — not just delete this test.
    expect([...CORE_CONTRACT_KEYS, ...VIEW_CONTRACT_KEYS]).not.toContain('whiteout')
    expect(Object.keys(resolveDeployment(11_155_111).schemas)).not.toContain('whiteout')
  })
})

describe('built-in registry — community devnet (26001993)', () => {
  it('resolveDeployment(26001993) throws DeploymentNotFound naming the override escape hatch (ADR-0018)', () => {
    // The live devnet runs fork-local addresses + different schema UIDs (probed
    // 2026-08-07) — the old `{...SEPOLIA, chainId}` entry could not serve one
    // successful call, so the registry refuses instead of silently mis-resolving.
    const err = (() => {
      try {
        resolveDeployment(26_001_993)
        return undefined
      } catch (e) {
        return e as Error
      }
    })()
    expect(err).toBeInstanceOf(EfsError)
    expect(err?.message).toMatch(/deployments/)
    expect(err?.message).toMatch(/devnet/)
  })
})
