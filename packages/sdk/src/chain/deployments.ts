/**
 * Per-chain deployments registry (ADR-0005): the SDK is a client + an address
 * book, not a deployer. It resolves EFS by chainId; a custom/local chain is
 * supplied via the `deployments` config override.
 */

import type { Address, Hex, PublicClient } from 'viem'
import { DeploymentNotFound, EfsError } from '../errors.js'

/** The EFS + EAS contract addresses on a chain. The view/router addresses are the
 * read-resolution trust root, so they are integrity-checked at construct time. */
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
  aliasResolver: Address
}

/** The 9 frozen EFS schema UIDs (contracts ADR-0048). */
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
 * Construct-time integrity gate (ADR-0005 / review S1). The view/router addresses
 * resolve every read, so a wrong, typo'd, or non-contract address must be rejected
 * loudly — not silently resolve to nothing. Verifies each EFS contract has deployed
 * bytecode on the target chain.
 *
 * TODO(build): also assert `deployment.schemas` match the indexer's on-chain UID
 * getters once the eas read layer lands (catches a UID/registry mismatch).
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
