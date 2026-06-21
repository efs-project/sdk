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
import { describe, expect, it } from 'vitest'
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

describe('built-in registry — Sepolia (11155111)', () => {
  it('resolveDeployment(11155111) returns the seeded Sepolia deployment (no override)', () => {
    const dep = resolveDeployment(11_155_111)
    expect(dep.chainId).toBe(11_155_111)
    // Canonical addresses from contracts docs/CHAINS.md (frozen 2026-06-19).
    expect(dep.contracts.indexer).toBe('0xc4DeaBB482C2FA74690629eEa662efb166BD658a')
    expect(dep.contracts.eas).toBe('0xC2679fBD37d54388Ce493F1DB75320D236e1815e')
    expect(dep.contracts.aliasResolver).toBe('0xB07225842d6513239a3519ae052B5bc7EBf18996')
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
})
