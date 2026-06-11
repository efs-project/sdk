/**
 * `@efs/sdk/chain` subpath entry — the per-chain deployments registry (ADR-0005).
 * Thin barrel: re-exports the curated chain surface from `./deployments.js`.
 */

export {
  deployments,
  resolveDeployment,
  assertDeploymentIntegrity,
  type DeploymentsMap,
  type EfsDeployment,
  type EfsContracts,
  type EfsSchemaUIDs,
} from './deployments.js'
