/**
 * @efs/sdk — TypeScript SDK for the Ethereum File System (EFS).
 *
 * Resource-namespaced client (ADR / Decision F): `efs.fs.*` (files),
 * `efs.lenses.*` (resolution), `efs.eas.*` (viem-native EAS), `efs.raw.*`
 * (deployment escape hatch). Shapes follow planning/Designs/sdk-architecture.md;
 * unbuilt methods throw `NotImplemented` with their final signatures so the
 * public surface is stable before publish.
 */

import type { Address, PublicClient, WalletClient } from 'viem'
import {
  type DeploymentsMap,
  type EfsDeployment,
  assertDeploymentIntegrity,
  resolveDeployment,
} from './chain/deployments.js'
import {
  SchemaEncoder,
  computeAttestationUID,
  easAbi,
  schemaRegistryAbi,
  verifyAttestationUID,
} from './eas/index.js'
import { EfsError, NotImplemented } from './errors.js'
import { type Lens, identity, lens, resolveLens } from './lenses/resolve.js'
import type {
  DataRef,
  EfsFile,
  ReadResult,
  Stat,
  WriteEstimate,
  WriteOptions,
  WriteReceipt,
} from './types.js'

export type EfsClientConfig = {
  publicClient: PublicClient
  /** Required for writes; reads work without it. */
  walletClient?: WalletClient
  /** Override the built-in registry to point at a custom/local deployment. */
  deployments?: DeploymentsMap
  /** Default lens when a read passes none (resolves to the connected wallet). */
  defaultLens?: Lens
}

export type EfsClient = {
  /** Files. */
  fs: {
    write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteReceipt>
    read(path: string, opts?: { as?: Lens | Address }): Promise<ReadResult | null>
    fetch(ref: DataRef, opts?: { verify?: boolean }): Promise<EfsFile>
    stat(path: string, opts?: { as?: Lens | Address }): Promise<Stat | null>
    list(path: string, opts?: { as?: Lens | Address }): AsyncIterable<DataRef>
    preview(path: string, content: Uint8Array): Promise<WriteEstimate>
  }
  /** Lens resolution. */
  lenses: {
    resolve(input: Lens | Address): Promise<readonly Address[]>
    lens: typeof lens
    identity: typeof identity
  }
  /** viem-native EAS access (ADR-0002). */
  eas: {
    encoder(schema: string): SchemaEncoder
    computeUID: typeof computeAttestationUID
    verifyUID: typeof verifyAttestationUID
    abi: { eas: typeof easAbi; schemaRegistry: typeof schemaRegistryAbi }
  }
  /** The resolved deployment for the connected chain (escape hatch). */
  raw: {
    deployment(): EfsDeployment
    verifyDeployment(): Promise<void>
  }
}

function chainIdOf(publicClient: PublicClient): number {
  const id = publicClient.chain?.id
  if (id === undefined) {
    throw new EfsError('publicClient has no `chain` set — cannot resolve the EFS deployment.')
  }
  return id
}

export function createEfsClient(config: EfsClientConfig): EfsClient {
  const { publicClient, deployments: override } = config
  const getDeployment = () => resolveDeployment(chainIdOf(publicClient), override)

  return {
    fs: {
      // Stubs reject/throw-on-iterate (not sync-throw) so the async contract is
      // locked now — callers' `.catch()` / `for await` behave as they will post-build.
      write: async (_path, _content, _opts) => {
        throw new NotImplemented('efs.fs.write()')
      },
      read: async (_path, _opts) => {
        throw new NotImplemented('efs.fs.read()')
      },
      fetch: async (_ref, _opts) => {
        throw new NotImplemented('efs.fs.fetch()')
      },
      stat: async (_path, _opts) => {
        throw new NotImplemented('efs.fs.stat()')
      },
      list: (_path, _opts) => ({
        [Symbol.asyncIterator]() {
          throw new NotImplemented('efs.fs.list()')
        },
      }),
      preview: async (_path, _content) => {
        throw new NotImplemented('efs.fs.preview()')
      },
    },
    lenses: {
      resolve: (input) => resolveLens(input, { publicClient }),
      lens,
      identity,
    },
    eas: {
      encoder: (schema) => new SchemaEncoder(schema),
      computeUID: computeAttestationUID,
      verifyUID: verifyAttestationUID,
      abi: { eas: easAbi, schemaRegistry: schemaRegistryAbi },
    },
    raw: {
      deployment: getDeployment,
      verifyDeployment: () => assertDeploymentIntegrity(publicClient, getDeployment()),
    },
  }
}

// ── Standalone exports (chain-independent; usable now) ─────────────────────────
export * from './eas/index.js'
export { hashContent, verifyContent, type VerificationStatus } from './content/hash.js'
export { lens, identity, resolveLens, MAX_LENSES, type Lens } from './lenses/resolve.js'
export {
  deployments,
  resolveDeployment,
  assertDeploymentIntegrity,
  type DeploymentsMap,
  type EfsDeployment,
  type EfsContracts,
  type EfsSchemaUIDs,
} from './chain/deployments.js'
export * from './errors.js'
export type {
  DataRef,
  DataUID,
  PathRef,
  ReadResult,
  EfsFile,
  WriteReceipt,
  WriteEstimate,
  WriteOptions,
  Stat,
} from './types.js'
