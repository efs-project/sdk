/**
 * @efs/sdk — TypeScript SDK for the Ethereum File System (EFS).
 *
 * Resource-namespaced client (Decision F): `efs.fs.*` (files), `efs.lenses.*`,
 * `efs.eas.*` (viem-native EAS), `efs.raw.*` (deployment escape hatch). Write
 * capability is gated at the TYPE level — a client built without a `walletClient`
 * doesn't expose `efs.fs.write`/`preview`/`batch` (viem's read/write split).
 * Unbuilt methods reject with `NotImplemented`, locking signatures before publish.
 *
 * Namespaces from the full design not yet on the client (`graph`/`props`/`lists`/
 * `sorts`) are additive — adding a top-level namespace is non-breaking — and are
 * designed in a dedicated pass; the option/return/pagination/batch *seams* below
 * are the ones that would force a breaking change, so they exist now.
 */

import {
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
} from 'viem'
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
import { EfsError, NotImplemented, WalletRequired } from './errors.js'
import { type Lens, identity, lens, resolveLens } from './lenses/resolve.js'
import type {
  BatchReceipt,
  DataRef,
  EfsFile,
  EfsList,
  FetchOptions,
  FileStat,
  ListOptions,
  ReadOptions,
  ReadResult,
  WriteEstimate,
  WriteOptions,
  WriteReceipt,
} from './types.js'

/**
 * The SDK's boundary is the **standard** (EIP-1193 provider + EIP-155 chain), not
 * a library (ADR-0009 / docs/specs/standards.md). viem is the engine *inside* —
 * we wrap the provider with viem's `custom()` transport. Any wallet (MetaMask,
 * WalletConnect, Coinbase, hardware, embedded) is an EIP-1193 provider, so all of
 * them work; a future ethers/other adapter just produces a provider, no break.
 */

/** Shared config. */
type CommonConfig = {
  /** Override the built-in registry to point at a custom/local deployment. */
  deployments?: DeploymentsMap
  /** Default lens when a read passes none (resolves to the connected account). */
  defaultLens?: Lens
}

/** Standard form: an EIP-1193 provider + the chain. Pass an `account` to enable writes. */
export type ProviderConfig = CommonConfig & {
  /** Any EIP-1193 provider — `window.ethereum`, a WalletConnect session, a viem
   * client's transport, etc. The durable, library-neutral input. */
  provider: EIP1193Provider
  /** The chain (EIP-155) the provider talks to. */
  chain: Chain
  /** The signing account for writes; omit for a read-only client. */
  account?: Address | Account
}

/** Convenience form: pre-configured viem clients (for viem-native callers). */
export type ViemConfig = CommonConfig & {
  publicClient: PublicClient
  /** Required for writes; presence gates write methods at the type level. */
  walletClient?: WalletClient
}

export type EfsClientConfig = ProviderConfig | ViemConfig

/** Normalize either config form to the viem clients the SDK uses internally. */
function resolveClients(config: EfsClientConfig): {
  publicClient: PublicClient
  walletClient: WalletClient | undefined
} {
  if ('provider' in config) {
    const transport = custom(config.provider)
    const publicClient = createPublicClient({ chain: config.chain, transport })
    const walletClient =
      config.account !== undefined
        ? createWalletClient({ chain: config.chain, account: config.account, transport })
        : undefined
    return { publicClient, walletClient }
  }
  return { publicClient: config.publicClient, walletClient: config.walletClient }
}

/** Read-only file operations. */
export type EfsFsRead = {
  read(path: string, opts?: ReadOptions): Promise<ReadResult | null>
  fetch(ref: DataRef, opts?: FetchOptions): Promise<EfsFile>
  stat(path: string, opts?: ReadOptions): Promise<FileStat | null>
  list(path: string, opts?: ListOptions): EfsList<DataRef>
}

/** Read + write file operations (only present when a `walletClient` is set). */
export type EfsFsWrite = EfsFsRead & {
  write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteReceipt>
  preview(path: string, content: Uint8Array): Promise<WriteEstimate>
}

export type EfsLensesNs = {
  resolve(input: Lens | Address): Promise<readonly Address[]>
  lens: typeof lens
  identity: typeof identity
}

export type EfsEasNs = {
  encoder(schema: string): SchemaEncoder
  computeUID: typeof computeAttestationUID
  verifyUID: typeof verifyAttestationUID
  abi: { eas: typeof easAbi; schemaRegistry: typeof schemaRegistryAbi }
}

export type EfsRawNs = {
  deployment(): EfsDeployment
  verifyDeployment(): Promise<void>
}

/** Read-capable client (no `walletClient`). */
export type EfsReadClient = {
  fs: EfsFsRead
  lenses: EfsLensesNs
  eas: EfsEasNs
  raw: EfsRawNs
}

/** Full client (a `walletClient` was supplied): reads + writes + batching. */
export type EfsClient = EfsReadClient & {
  fs: EfsFsWrite
  /** Compose a multi-operation write delivered with one signature where possible. */
  batch(): { execute(): Promise<BatchReceipt> }
}

function chainIdOf(publicClient: PublicClient): number {
  const id = publicClient.chain?.id
  if (id === undefined) {
    throw new EfsError('publicClient has no `chain` set — cannot resolve the EFS deployment.', {
      code: 'DeploymentNotFound',
    })
  }
  return id
}

// Type-level write gate: a write-capable config (an `account` in the provider form,
// or a `walletClient` in the viem form) widens the return to `EfsClient`; otherwise
// you get `EfsReadClient` (no write verbs).
export function createEfsClient(config: ProviderConfig & { account: Address | Account }): EfsClient
export function createEfsClient(config: ViemConfig & { walletClient: WalletClient }): EfsClient
export function createEfsClient(config: EfsClientConfig): EfsReadClient
export function createEfsClient(config: EfsClientConfig): EfsClient {
  const { publicClient, walletClient } = resolveClients(config)
  const override = config.deployments
  const getDeployment = () => resolveDeployment(chainIdOf(publicClient), override)
  const requireWallet = () => {
    if (!walletClient) throw new WalletRequired()
  }

  return {
    fs: {
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
        page: async () => {
          throw new NotImplemented('efs.fs.list().page()')
        },
      }),
      write: async (_path, _content, _opts) => {
        requireWallet()
        throw new NotImplemented('efs.fs.write()')
      },
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
    batch: () => {
      requireWallet()
      throw new NotImplemented('efs.batch()')
    },
  }
}

// ── Standalone exports (chain-independent; usable now) ─────────────────────────
export {
  SchemaEncoder,
  buildAttest,
  buildMultiAttest,
  computeAttestationUID,
  verifyAttestationUID,
  parseSchema,
  easAbi,
  schemaRegistryAbi,
  type AttestationRequest,
  type AttestationRequestData,
  type MultiAttestationRequest,
} from './eas/index.js'
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
  ReadOptions,
  ListOptions,
  FetchOptions,
  WriteOptions,
  Page,
  EfsList,
  ReadResult,
  EfsFile,
  FileStat,
  WriteReceipt,
  WriteMechanism,
  WriteEstimate,
  OperationResult,
  BatchReceipt,
} from './types.js'
