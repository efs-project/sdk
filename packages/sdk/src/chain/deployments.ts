/**
 * Per-chain deployments registry (ADR-0005): the SDK is a client + an address
 * book, not a deployer. It resolves EFS by chainId; a custom/local chain is
 * supplied via the `deployments` config override.
 */

import type { Abi, Address, Hex, PublicClient } from 'viem'
import { keccak256 } from 'viem'
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

/**
 * The PERMANENT contract keys: Safe-keyed CREATE3 proxies whose addresses hash
 * into the frozen schema UIDs (identical on any chain the same Safe deploys
 * from, CHAINS.md §core) + the two external EAS singletons. These never move —
 * moving one orphans every attestation under its schemas.
 */
export const CORE_CONTRACT_KEYS = [
  'eas',
  'schemaRegistry',
  'indexer',
  'edgeResolver',
  'mirrorResolver',
  'listResolver',
  'listEntryResolver',
  'aliasResolver',
  'systemAccount',
] as const satisfies readonly (keyof EfsContracts)[]

/**
 * The REPLACEABLE view keys: stateless, ownerless, in NO schema UID
 * (CHAINS.md §read views) — redeployable at any time, at which point off-chain
 * consumers (this registry) update. Because OLD view revisions keep their
 * bytecode, a code-exists check can silently pin a pre-hardening revision; the
 * per-deployment {@link EfsViewRevision} codehashes are the honest gate.
 */
export const VIEW_CONTRACT_KEYS = [
  'router',
  'fileView',
  'listReader',
] as const satisfies readonly (keyof EfsContracts)[]

/**
 * The recorded VIEW revision for a deployment: which redeploy of the stateless
 * views this registry pins, plus the runtime codehashes read back from the live
 * chain at record time (a READBACK, not compiler output — contracts#44's "a
 * recorded readback supports every live claim"). `verifyDeployment` checks the
 * recorded codehashes so a stale-but-still-has-bytecode view address fails
 * loudly instead of silently serving a pre-hardening revision.
 */
export type EfsViewRevision = {
  /** Human-readable revision id (e.g. `sepolia-views-2026-06-23`). */
  revision: string
  /** The block(s) the revision deployed at (informational). */
  deployedAtBlock?: number
  /** keccak256 of each view's RUNTIME bytecode, from a live readback. */
  codehash?: Partial<Record<(typeof VIEW_CONTRACT_KEYS)[number], Hex>>
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
  /** The pinned view-revision record ({@link EfsViewRevision}); optional — an
   * override without it skips the codehash gate (back-compat). */
  views?: EfsViewRevision
}

export type DeploymentsMap = Record<number, EfsDeployment>

/**
 * Sepolia (chainId 11155111) — frozen 2026-06-19 (9 schemas registered + scaffolding
 * sealed). Record precedence (ADR-0018, extending ADR-0012): the contracts repo's
 * hardhat deployment artifacts (`packages/hardhat/deployments/sepolia/*.json`) +
 * `docs/CHAINS.md` (which agree), NEVER `deployedContracts.ts` (the stale record
 * behind the June-23 view drift, contracts#43). Core contracts are Safe-keyed
 * CREATE3 proxies (permanent); the views carry the 2026-06-23 hardened revision
 * (ADR-0057/0058/0059) with readback codehashes so `verifyDeployment` catches a
 * stale view address that still has (old) bytecode.
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
    router: '0x44D5F6803127B442218e9aA0481A9931444dc82c',
    fileView: '0x76B10909Ff10b53c54387C66B083b1613E2276d3',
    edgeResolver: '0xD6643DB36B20895E3E46aD08cdD4ED4BC1dBB7F1',
    mirrorResolver: '0xd4991Ced6D460A3794E9120dC6C19975092982b9',
    listResolver: '0x678883253e0edA926aC48F23655967e78E7d464C',
    listEntryResolver: '0x7a14832E355d5937019C3D0b72bd11F2dbD5e513',
    listReader: '0xCc182611B572b5C162a3D96674E821C61ac658FC',
    aliasResolver: '0xB07225842d6513239a3519ae052B5bc7EBf18996',
    systemAccount: '0x63DEA7336C4217B7c5433eE3CB21Bb6a6813588d',
  },
  views: {
    revision: 'sepolia-views-2026-06-23',
    deployedAtBlock: 11121023,
    // Runtime codehashes from a live Sepolia readback (independently re-derived
    // 2026-08-07: keccak256(eth_getCode)). NOTE the honest detection boundary:
    // the OLD FileView/ListReader deploys are byte-identical to these (same
    // runtime code incl. immutables — behaviorally equivalent, undetectable =
    // harmless); only the ROUTER actually changed (ADR-0058 hardening), so the
    // router hash is what catches the June-23 drift this record exists for.
    codehash: {
      router: '0xecbc691d0f06885340ed0ad91ab0e4975e3ca7a964037d37d33cf93aca91d1b0',
      fileView: '0x2260995dec16c58b094b77701337fd7b1a48ec5cce3f7a49714cb17778460b7e',
      listReader: '0xce17a97e5a2ffd6e36c3edb1f61c79af032125a7b207521d4696ad6fc27d7f1b',
    },
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
 * The community devnet (chainId 26001993, contracts ADR-0062) is deliberately
 * NOT in the built-in registry (ADR-0018). The "devnet mirrors Sepolia
 * addresses/UIDs" design is currently FALSE on the live devnet: a 2026-08-07
 * probe found NO code at any Sepolia CREATE3 core address, fork-local (31337-
 * block) resolver proxies instead, and a DIFFERENT `ANCHOR_SCHEMA_UID` — and
 * the drift is structural, not a stale reset: the hardhat fork pin
 * (`FORK_BLOCK=10_691_000`) predates the Sepolia freeze/view blocks (~11.12M),
 * so fork-derived chains cannot inherit the Sepolia record. A built-in entry
 * that cannot serve one successful call is worse than a clear error; pass a
 * correct devnet record via the `deployments` override, and this entry returns
 * when either the devnet is re-provisioned to genuinely mirror Sepolia or
 * contracts#43 ships an independently-generated devnet profile.
 */
export const DEVNET_CHAIN_ID = 26001993

/**
 * Built-in registry. Seeded from the contracts repo record (hardhat artifacts +
 * `docs/CHAINS.md`) as EFS freezes on a chain (ADR-0005/ADR-0018). Sepolia only
 * today — for the community devnet (see {@link DEVNET_CHAIN_ID}), a local fork
 * (chainId 31337), or any custom chain, pass `deployments` in the client config.
 */
export const deployments: DeploymentsMap = {
  [SEPOLIA.chainId]: SEPOLIA,
}

/** Canonicalize one bytes32 UID to the form the WHOLE SDK consumes: `0x` + 64
 * LOWERCASE hex. Accepts the value-equal variants a registry entry may be
 * written in (uppercase, leading-zero-shortened `0x01`) — the same tolerance
 * `sameUid` extends at verification — but REWRITES them, because tolerance at
 * the compare alone is not enough: reads do strict string equality against
 * EAS-returned UIDs (e.g. the symlink walk would report a valid redirect
 * target as dangling), and a shortened value cannot be ABI-encoded as
 * `bytes32`. Rejects anything else with a typed, actionable error. */
function canonicalUid(value: string, label: string): Hex {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new EfsError(
      `EFS deployment: schemas.${label} ("${String(value)}") is not a bytes32 hex UID the SDK can consume — expected 0x-prefixed hex, at most 32 bytes (canonical form: 0x + exactly 64 lowercase hex chars).`,
      { code: 'InvalidArgument' },
    )
  }
  return `0x${value.slice(2).toLowerCase().padStart(64, '0')}` as Hex
}

/** Per-record memo for {@link canonicalizeDeployment} — `resolveDeployment` is
 * on the lazy-getter hot path (every `efs.raw.*` access re-resolves), so the
 * nine-string rewrite runs once per distinct record object. */
const canonicalMemo = new WeakMap<EfsDeployment, EfsDeployment>()

/** A COPY of the record with every schema UID canonicalized (the source —
 * often the shared registry object or the caller's override — is never
 * mutated). */
function canonicalizeDeployment(dep: EfsDeployment): EfsDeployment {
  const memo = canonicalMemo.get(dep)
  if (memo !== undefined) return memo
  const schemas = Object.fromEntries(
    Object.entries(dep.schemas).map(([k, v]) => [k, canonicalUid(v as string, k)]),
  ) as EfsDeployment['schemas']
  const out = { ...dep, schemas }
  canonicalMemo.set(dep, out)
  return out
}

/** Resolve the deployment for a chain, preferring a caller override. The
 * returned record's schema UIDs are CANONICALIZED (0x + 64 lowercase hex) —
 * see {@link canonicalUid}: verification is value-tolerant of how an override
 * writes a UID, so the rest of the SDK must never see the non-canonical form. */
export function resolveDeployment(chainId: number, override?: DeploymentsMap): EfsDeployment {
  const map = override ?? deployments
  const found = map[chainId]
  if (!found) {
    if (chainId === DEVNET_CHAIN_ID && override === undefined) {
      throw new DeploymentNotFound(
        chainId,
        'The community devnet currently runs fork-local addresses/UIDs that do NOT mirror the built-in Sepolia record (see ADR-0018) — pass its actual deployment via the `deployments` override.',
      )
    }
    throw new DeploymentNotFound(chainId)
  }
  return canonicalizeDeployment(found)
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
 * View-revision codehash gate (ADR-0018). For each view key with a recorded
 * readback codehash ({@link EfsViewRevision.codehash}), keccak256 of the LIVE
 * runtime bytecode must match — this is what catches a stale-but-still-
 * has-bytecode view address (the June-23 router drift class, contracts#43),
 * which neither the code-exists check nor the schema-UID gate can see (views
 * are in no schema UID by design — no on-chain getter vouches for them).
 *
 * Honest limits: it CANNOT distinguish byte-identical redeploys (behaviorally
 * equivalent — harmless), CANNOT know a newer canonical revision exists
 * upstream (that is the drift-CI script's job, `scripts/check-deployment-drift.mjs`),
 * trusts the RPC for `eth_getCode`, and deliberately does NOT pin implementation
 * hashes behind the upgradeable CORE proxies (legitimate pre-burn Safe upgrades
 * would false-positive; revisit at burn). Skipped entirely when no codehashes
 * are recorded (override back-compat — zero extra reads).
 */
export async function assertViewRevision(
  publicClient: PublicClient,
  deployment: EfsDeployment,
): Promise<void> {
  const pins = deployment.views?.codehash
  if (pins === undefined) return
  for (const key of VIEW_CONTRACT_KEYS) {
    const expected = pins[key]
    if (expected === undefined) continue
    const addr = deployment.contracts[key]
    const code = await publicClient.getCode({ address: addr })
    const got = keccak256((code ?? '0x') as Hex)
    if (got.toLowerCase() !== expected.toLowerCase()) {
      throw new EfsError(
        `EFS view-revision check failed on chainId ${deployment.chainId}: '${key}' at ${addr} has runtime codehash ${got}, but the registry pins ${expected} (revision '${deployment.views?.revision}'). The address likely points at a stale/foreign view revision — update the registry (or your \`deployments\` override) to the current canonical record.`,
      )
    }
  }
}

/**
 * Full deployment trust gate: bytecode presence ({@link
 * assertDeploymentIntegrity}) **then** schema-UID authenticity ({@link
 * assertSchemaIntegrity}) **then** the view-revision codehash gate ({@link
 * assertViewRevision}). Bytecode runs first so a missing/typo'd address
 * surfaces as the clearer `EfsError` before any schema read is attempted; the
 * view gate runs last so the clearer diffs win.
 *
 * Opt-in by design (ADR-0005): the client does NOT run this on every construct —
 * that would add an RPC round-trip to a path that may never touch a custom
 * deployment. It's exposed as `efs.raw.verifyDeployment()` for a caller to run
 * once after wiring a `deployments` override (recommended), and is cheap enough
 * to run eagerly in that case (nine `eth_call`s + three `getCode`s, batched).
 */
export async function verifyDeployment(
  publicClient: PublicClient,
  deployment: EfsDeployment,
): Promise<void> {
  await assertDeploymentIntegrity(publicClient, deployment)
  await assertSchemaIntegrity(publicClient, deployment)
  await assertViewRevision(publicClient, deployment)
}
