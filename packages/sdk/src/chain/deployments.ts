/**
 * Per-chain deployments registry (ADR-0005): the SDK is a client + an address
 * book, not a deployer. It resolves EFS by chainId; a custom/local chain is
 * supplied via the `deployments` config override.
 */

import type { Abi, Address, Hex, PublicClient } from 'viem'
import { DeploymentNotFound, EfsError, SchemaMismatchError } from '../errors.js'
import { aliasResolverAbi, indexerAbi, listEntryResolverAbi, listResolverAbi } from './abi/index.js'

/** The EFS + EAS contract addresses on a chain. The view/router addresses are the
 * read-resolution trust root, so they are integrity-checked at construct time.
 *
 * Keys mirror the frozen contracts set (Sepolia freeze, contracts repo
 * `docs/SEPOLIA_FREEZE_TABLE.md`): `Indexer`, `EFSRouter`, `EFSFileView`,
 * `EdgeResolver`, `MirrorResolver`, `ListResolver`, `ListEntryResolver`,
 * `ListReader`, `AliasResolver`, `SystemAccount` — plus the two external EAS
 * contracts EFS is registered against. `AliasResolver` IS a standalone deployed
 * contract (ADR-0050): it owns the REDIRECT schema and self-derives its UID via
 * `redirectSchemaUID()`; REDIRECT resolution is no longer in EFSRouter.
 * `SystemAccount` is the sealed system-writer relay (`bootstrap`/`sealModules`,
 * ADR-0053). `EFSSortOverlay` and `SchemaNameIndex` are NOT in the frozen set
 * (SORT_INFO deferred, NAMING dropped). */
export type EfsContracts = {
  eas: Address
  schemaRegistry: Address
  indexer: Address
  router: Address
  fileView: Address
  edgeResolver: Address
  mirrorResolver: Address
  listResolver: Address
  listEntryResolver: Address
  listReader: Address
  aliasResolver: Address
  systemAccount: Address
}

/** The frozen EFS schema-UID set — the canonical 9 (Sepolia freeze, contracts
 * repo `docs/SEPOLIA_FREEZE_TABLE.md`): ANCHOR, PROPERTY, DATA, PIN, TAG, MIRROR,
 * LIST, LIST_ENTRY, REDIRECT.
 *
 * `redirect` is a frozen first-class schema (ADR-0050, resolver = AliasResolver).
 * `blob` and `naming` were dropped from the prior reconciliation; `sortInfo`
 * (SORT_INFO) is deferred — addable later without orphaning, so it is not in the
 * frozen set. The exact field strings these UIDs derive from live in
 * {@link EFS_SCHEMA_FIELDS} (`../eas/schemas.ts`). */
export type EfsSchemaUIDs = {
  anchor: Hex
  property: Hex
  data: Hex
  pin: Hex
  tag: Hex
  mirror: Hex
  list: Hex
  listEntry: Hex
  redirect: Hex
}

/**
 * The on-chain `/transports/<scheme>` anchor UIDs, keyed by URI scheme (`web3`,
 * `ipfs`, `arweave`, `https`, `magnet`, `data`, …). A MIRROR's `transportDefinition`
 * field is the anchor UID for its scheme (ADR-0011, contracts: transports are
 * anchors under `/transports/`). The deploy seeds these; the write path reads the
 * relevant one when authoring a MIRROR. Optional + additive — absent on a
 * deployment that hasn't recorded them, in which case a write must supply the UID
 * via `WriteOptions.transportDefinition` (or fail with a clear `MissingTransport`).
 */
export type EfsTransports = Partial<Record<string, Hex>>

export type EfsDeployment = {
  chainId: number
  contracts: EfsContracts
  schemas: EfsSchemaUIDs
  /** Per-scheme `/transports/<scheme>` anchor UIDs (ADR-0011); optional/additive. */
  transports?: EfsTransports
}

export type DeploymentsMap = Record<number, EfsDeployment>

/**
 * Built-in registry. Populated as EFS deploys to chains; values are
 * deploy-derived (addresses from the atomic CREATE3 deploy, UIDs from the
 * registered schemas — ADR-0005). Pre-launch this is empty: Sepolia (11155111)
 * lands after the freeze sign-off + CREATE3 deploy (UIDs/addresses are TBD until
 * then, so nothing is seeded here — do not seed from a stale
 * `deployedContracts.ts` snapshot). For a local fork (chainId 31337) until then,
 * pass `deployments` in the client config.
 */
export const deployments: DeploymentsMap = {}

/** Resolve the deployment for a chain, preferring a caller override. */
export function resolveDeployment(chainId: number, override?: DeploymentsMap): EfsDeployment {
  const map = override ?? deployments
  const found = map[chainId]
  if (!found) throw new DeploymentNotFound(chainId)
  return found
}

/**
 * Construct-time sanity gate (ADR-0005 / review S1). Verifies each EFS contract
 * address has *some* bytecode on the target chain — this catches a wrong/typo'd
 * or non-contract address, nothing more. It does NOT authenticate that the code
 * is the *right* EFS contract; for that, see {@link assertSchemaIntegrity}.
 *
 * Treat a passing bytecode check as "addresses are contracts," not "addresses
 * are EFS." {@link verifyDeployment} runs both gates back to back.
 */
export async function assertDeploymentIntegrity(
  publicClient: PublicClient,
  deployment: EfsDeployment,
): Promise<void> {
  for (const [name, addr] of Object.entries(deployment.contracts)) {
    const code = await publicClient.getCode({ address: addr })
    if (!code || code === '0x') {
      throw new EfsError(
        `EFS deployment integrity check failed: contract '${name}' at ${addr} has no bytecode on chainId ${deployment.chainId}.`,
      )
    }
  }
}

/**
 * One schema-UID source: the deployment key, the contract address that owns the
 * authoritative getter, the ABI + function to read, and the expected (registered)
 * UID from the `deployment.schemas` map.
 */
type SchemaUidSource = {
  /** The key in {@link EfsSchemaUIDs} this source authenticates. */
  schema: keyof EfsSchemaUIDs
  /** Human label for the on-chain source (used in the mismatch diff). */
  sourceLabel: string
  /** The contract whose getter is authoritative for this UID. */
  address: Address
  abi: Abi
  functionName: string
  /** The UID the (possibly overridden) deployment claims for this schema. */
  expected: Hex
}

/**
 * Map every frozen schema UID to its **authoritative** on-chain getter. Not all
 * nine live on the Indexer — three are self-derived by their resolver against
 * that resolver's own (proxy) address, so the resolver is the only contract that
 * can vouch for them (ADR-0048):
 *
 *   - anchor / property / data / pin / tag / mirror → Indexer `*_SCHEMA_UID()`
 *     (the kernel's ERC-7201 config; EFSIndexer.sol).
 *   - list      → ListResolver.listSchemaUID()       (self-derived, baked into the UID).
 *   - listEntry → ListEntryResolver.listEntrySchemaUID() (self-derived; no Indexer getter).
 *   - redirect  → AliasResolver.redirectSchemaUID()  (self-derived; no Indexer getter).
 *
 * Reading each from its own owner is what makes a `deployments` override safe to
 * trust: a wrong/hostile contract set can't fake the frozen UIDs without also
 * controlling the address each UID hashes in.
 */
function schemaUidSources(deployment: EfsDeployment): SchemaUidSource[] {
  const { contracts, schemas } = deployment
  const indexer = (functionName: string, schema: keyof EfsSchemaUIDs): SchemaUidSource => ({
    schema,
    sourceLabel: `Indexer.${functionName}`,
    address: contracts.indexer,
    abi: indexerAbi as unknown as Abi,
    functionName,
    expected: schemas[schema],
  })
  return [
    indexer('ANCHOR_SCHEMA_UID', 'anchor'),
    indexer('PROPERTY_SCHEMA_UID', 'property'),
    indexer('DATA_SCHEMA_UID', 'data'),
    indexer('PIN_SCHEMA_UID', 'pin'),
    indexer('TAG_SCHEMA_UID', 'tag'),
    indexer('MIRROR_SCHEMA_UID', 'mirror'),
    {
      schema: 'list',
      sourceLabel: 'ListResolver.listSchemaUID',
      address: contracts.listResolver,
      abi: listResolverAbi as unknown as Abi,
      functionName: 'listSchemaUID',
      expected: schemas.list,
    },
    {
      schema: 'listEntry',
      sourceLabel: 'ListEntryResolver.listEntrySchemaUID',
      address: contracts.listEntryResolver,
      abi: listEntryResolverAbi as unknown as Abi,
      functionName: 'listEntrySchemaUID',
      expected: schemas.listEntry,
    },
    {
      schema: 'redirect',
      sourceLabel: 'AliasResolver.redirectSchemaUID',
      address: contracts.aliasResolver,
      abi: aliasResolverAbi as unknown as Abi,
      functionName: 'redirectSchemaUID',
      expected: schemas.redirect,
    },
  ]
}

/**
 * Compare two `bytes32` UIDs by value, tolerant of casing and leading-zero
 * width (`0xAB…` vs `0xab…`, `0x01` vs `0x00…01`) — viem returns the canonical
 * 32-byte form, while a registry entry may be written either way. A non-hex /
 * unparseable value never equals (fail-closed). */
function sameUid(a: Hex, b: Hex): boolean {
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    return false
  }
}

/**
 * The real trust gate (ADR-0005 / review P1 #9). For each of the nine frozen
 * schema UIDs, read the value its **authoritative** on-chain getter reports and
 * assert it equals what `deployment.schemas` claims. A wrong/hostile
 * `deployments` override fails here even when every address is a real contract
 * (which {@link assertDeploymentIntegrity} alone can't catch). Trust-resistance
 * is NOT uniform across the nine, though (review, 2026-06-20): the three
 * resolver-owned UIDs (list/listEntry/redirect) are read from getters that
 * **self-derive** the UID from the resolver's own (proxy) address, so they are
 * genuinely unforgeable — a wrong contract cannot return them. The six kernel
 * UIDs (anchor/property/data/pin/tag/mirror) are plain storage getters on the
 * Indexer, so this gate proves only that the Indexer **agrees with itself**; for
 * those six, the anchor of trust remains `contracts.indexer` being the right
 * address (taken on faith from the registry / override). So: strong proof for the
 * three self-derived resolvers, indexer-relative proof for the kernel six.
 *
 * The reads are batched via `Promise.all` (one `eth_call` per UID; viem will
 * fold them into a multicall when the chain supports it and the client has
 * `batch.multicall` enabled). On any mismatch this throws {@link
 * SchemaMismatchError} with a precise diff: which schema, expected vs on-chain,
 * and the source getter.
 */
export async function assertSchemaIntegrity(
  publicClient: PublicClient,
  deployment: EfsDeployment,
): Promise<void> {
  const sources = schemaUidSources(deployment)
  const onchain = await Promise.all(
    sources.map(
      (s) =>
        publicClient.readContract({
          address: s.address,
          abi: s.abi,
          functionName: s.functionName,
        }) as Promise<Hex>,
    ),
  )

  const diffs: string[] = []
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]
    const got = onchain[i]
    if (!s || got === undefined) continue
    if (!sameUid(s.expected, got)) {
      diffs.push(
        `  - ${s.schema}: deployment claims ${s.expected}, but ${s.sourceLabel} reports ${got}`,
      )
    }
  }

  if (diffs.length > 0) {
    const count = `${diffs.length} of ${sources.length} schema UID(s) do not match the on-chain source`
    const header = `EFS deployment schema-UID integrity check failed on chainId ${deployment.chainId} — ${count} (the \`deployments\` override does not point at the real EFS contracts):`
    throw new SchemaMismatchError(`${header}\n${diffs.join('\n')}`)
  }
}

/**
 * Full deployment trust gate: bytecode presence ({@link
 * assertDeploymentIntegrity}) **then** schema-UID authenticity ({@link
 * assertSchemaIntegrity}). Bytecode runs first so a missing/typo'd address
 * surfaces as the clearer `EfsError` before any schema read is attempted.
 *
 * Opt-in by design (ADR-0005): the client does NOT run this on every construct —
 * that would add an RPC round-trip to a path that may never touch a custom
 * deployment. It's exposed as `efs.raw.verifyDeployment()` for a caller to run
 * once after wiring a `deployments` override (recommended), and is cheap enough
 * to run eagerly in that case (nine `eth_call`s, batched).
 */
export async function verifyDeployment(
  publicClient: PublicClient,
  deployment: EfsDeployment,
): Promise<void> {
  await assertDeploymentIntegrity(publicClient, deployment)
  await assertSchemaIntegrity(publicClient, deployment)
}
