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
 * Sepolia (chainId 11155111) — frozen 2026-06-19 (9 schemas registered + scaffolding
 * sealed). Addresses + UIDs are the canonical record from the contracts repo
 * `docs/CHAINS.md`. Safe-keyed CREATE3 proxies (the read views EFSFileView/EFSRouter/
 * ListReader are stateless + redeployable — if they move, override at the client).
 *
 * `transports` is intentionally absent: the per-scheme `/transports/<scheme>` anchor
 * UIDs are runtime EAS UIDs (not derivable offline) and `docs/CHAINS.md` lists only the
 * `/transports` root. Reads work fully; a default on-chain (`web3://`) write needs the
 * per-scheme UID via `WriteOptions.transportDefinition` until the map is seeded (else a
 * clear `MissingTransport`). Add the per-scheme UIDs here once the deploy records them.
 */
export const SEPOLIA: EfsDeployment = {
  chainId: 11155111,
  contracts: {
    eas: '0xC2679fBD37d54388Ce493F1DB75320D236e1815e',
    schemaRegistry: '0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0',
    indexer: '0xc4DeaBB482C2FA74690629eEa662efb166BD658a',
    router: '0x4EF216e1096237dA8A962157Ed13ea1B3FcC5E17',
    fileView: '0x141D9FdbadCd9f6e6928A4842FF00094502CC146',
    edgeResolver: '0xD6643DB36B20895E3E46aD08cdD4ED4BC1dBB7F1',
    mirrorResolver: '0xd4991Ced6D460A3794E9120dC6C19975092982b9',
    listResolver: '0x678883253e0edA926aC48F23655967e78E7d464C',
    listEntryResolver: '0x7a14832E355d5937019C3D0b72bd11F2dbD5e513',
    listReader: '0x689AA70BF6a8b22BE4E959dcf33A40ea03F85Bd5',
    aliasResolver: '0xB07225842d6513239a3519ae052B5bc7EBf18996',
    systemAccount: '0x63DEA7336C4217B7c5433eE3CB21Bb6a6813588d',
  },
  schemas: {
    anchor: '0xf818abd74da70345c8acd7087e6ce69fd48eaf4e79c1931e5c6b08fb148c921a',
    property: '0xa1f54f2d395c24077e374d9a2d835a2d2fcb3b4c3e019f63525bee3424f1c246',
    data: '0xa3400cecc384d66d84f502fd91e56dc0321edccde9ef8e49d303ba63cc841b3c',
    pin: '0x5aaabaea19accff34c604f6f1b0dd2361a0a9ba64f7746ea6b3ed95d4047d878',
    tag: '0x0c41f8ee209fdbea4de3942c488a4098dd5a8bb1afce117857c5493002dd0e87',
    mirror: '0x9573ea8100bda88cc09ba275d8307b309c42ae82cca7f96ccf0e3eef4b5ea58d',
    list: '0x2e2801910184228802919fcc6f20c7e6c9e9c12fb8ae7a1f4e516cd3eeec6a59',
    listEntry: '0x9a22c62bf63ef3a04412c124747df97d9f9e81376fa202d4ed514d0a5e6c9af1',
    redirect: '0x5dca2fcc2c39c8629616b175a38c5e71d641b3019a3cb4ca790cc8fd32c9b8e0',
  },
}

/**
 * The shared community **devnet** (chainId 26001993) — the frictionless place for devs to
 * try EFS without burdening Sepolia or running a local node. It is a **Sepolia fork** on a
 * VPS (contracts ADR-0062), so its contract addresses AND the 9 schema UIDs are
 * BYTE-IDENTICAL to Sepolia — CREATE/CREATE2/CreateX and EAS schema UIDs are chain-id-
 * independent, so only the network identity differs. (Earlier forks reused `31337`; the
 * devnet now has its own id so a wallet can tell it apart from a contributor's local node.)
 *
 * Because the addresses/UIDs are the same frozen Sepolia record, this is as stable as
 * Sepolia — devnet *state* (faucet balances, attestations) is ephemeral/drainable, but the
 * deployment itself is not. A dev just points their viem `publicClient`/`walletClient` at
 * the devnet RPC and the SDK resolves this by chainId — no `deployments` override needed.
 */
export const DEVNET: EfsDeployment = { ...SEPOLIA, chainId: 26001993 }

/**
 * Built-in registry. Seeded from the contracts repo `docs/CHAINS.md` as EFS freezes on
 * a chain (addresses from the CREATE3 deploy, UIDs from the registered schemas — ADR-0005).
 * Carries Sepolia + the community devnet (a Sepolia fork; see {@link DEVNET}). For a local
 * fork (chainId 31337) or any custom chain, pass `deployments` in the client config.
 */
export const deployments: DeploymentsMap = {
  [SEPOLIA.chainId]: SEPOLIA,
  [DEVNET.chainId]: DEVNET,
}

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
