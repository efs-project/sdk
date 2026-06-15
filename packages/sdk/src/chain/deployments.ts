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
 * Keys mirror the contracts repo's deployed-contract set (chain 31337 in
 * `packages/nextjs/contracts/deployedContracts.ts`): `Indexer`, `EFSRouter`,
 * `EFSFileView`, `EdgeResolver`, `MirrorResolver`, `EFSSortOverlay`,
 * `ListResolver`, `ListEntryResolver`, `ListReader`, `SchemaNameIndex` — plus the
 * two external EAS contracts EFS is registered against. There is no `aliasResolver`:
 * schema/attestation alias-anchor resolution lives in EFSRouter (ADR-0033),
 * not a standalone contract. */
export type EfsContracts = {
  eas: Address
  schemaRegistry: Address
  indexer: Address
  router: Address
  fileView: Address
  edgeResolver: Address
  mirrorResolver: Address
  sortOverlay: Address
  listResolver: Address
  listEntryResolver: Address
  listReader: Address
  schemaNameIndex: Address
}

/** The frozen EFS schema-UID set (defined in the contracts repo).
 *
 * Keys mirror the on-chain `*_SCHEMA_UID` getters in `deployedContracts.ts`
 * (`Indexer` exposes ANCHOR/PROPERTY/DATA/BLOB/MIRROR/PIN/TAG/SORT_INFO;
 * `SchemaNameIndex` exposes NAMING; `ListResolver`/`ListEntryResolver` expose
 * LIST/LIST_ENTRY). There is no `redirect` schema — it does not exist in the
 * contracts repo (no registration in `deploy/`, no `_SCHEMA_UID` getter). */
export type EfsSchemaUIDs = {
  anchor: Hex
  property: Hex
  data: Hex
  blob: Hex
  pin: Hex
  tag: Hex
  mirror: Hex
  sortInfo: Hex
  list: Hex
  listEntry: Hex
  naming: Hex
}

export type EfsDeployment = {
  chainId: number
  contracts: EfsContracts
  schemas: EfsSchemaUIDs
}

export type DeploymentsMap = Record<number, EfsDeployment>

/**
 * Built-in registry. Populated as EFS deploys to chains; values are generated
 * from the contracts repo's deploy output (ADR-0005). Pre-launch this is empty —
 * Sepolia (11155111) lands after the freeze sign-off. For a local fork
 * (chainId 31337) until then, pass `deployments` in the client config.
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
 * indexer's UID getters.
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
