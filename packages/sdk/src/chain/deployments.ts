/**
 * Per-chain deployments registry (ADR-0005): the SDK is a client + an address
 * book, not a deployer. It resolves EFS by chainId; a custom/local chain is
 * supplied via the `deployments` config override.
 */

import type { Address, Hex, PublicClient } from 'viem'
import { DeploymentNotFound, EfsError } from '../errors.js'

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
 * is the *right* EFS contract.
 *
 * The real trust gate is the **schema-UID match**: assert `deployment.schemas`
 * equal the indexer's on-chain UID getters (a malicious/wrong indexer can't fake
 * the frozen UIDs). That lands with the read layer (TODO below) and is what makes
 * an overridden `deployments` map safe to trust. Until then, treat a passing
 * bytecode check as "addresses are contracts," not "addresses are EFS."
 *
 * TODO(build): add the schema-UID assertion once the eas read layer can call the
 * per-schema UID sources. They are NOT all on the Indexer:
 *   - anchor, property, data, pin, tag, mirror → Indexer getters.
 *   - list → ListResolver.
 *   - listEntry → ListEntryResolver (self-derived; no Indexer getter).
 *   - redirect → AliasResolver.redirectSchemaUID() (self-derived; no Indexer getter).
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
