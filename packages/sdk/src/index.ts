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
import type { ReadContext } from './reads/context.js'
import { cat as catRead, fetchRef } from './reads/fetch.js'
import { resolve as resolveRead, stat as statRead } from './reads/file.js'
import { list as listRead } from './reads/list.js'
import type {
  BatchReceipt,
  DataRef,
  DirEntry,
  EfsFile,
  EfsList,
  FetchOptions,
  FileStat,
  ListOptions,
  OverviewOptions,
  OverviewResult,
  PreviewOptions,
  ReadOptions,
  ReadResult,
  WriteEstimate,
  WriteOptions,
  WriteReceipt,
} from './types.js'
import { type FileWriteContext, writeFileTier1 } from './writes/file.js'

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
  /** Resolve a path to its active {@link DataRef} under the lens (no byte fetch).
   * `null` when nothing is placed there under the lens. */
  read(path: string, opts?: ReadOptions): Promise<ReadResult | null>
  /** Resolve a path AND fetch + verify its bytes — the full read pipeline. Returns
   * an {@link EfsFile} with a trust-relative verification status; throws
   * `FileNotFoundError` when nothing is placed at the path under the lens. (The
   * `read` verb keeps its resolve-only `ReadResult | null` shape; `cat` is the
   * byte-returning sibling.) */
  cat(path: string, opts?: ReadOptions & FetchOptions): Promise<EfsFile>
  fetch(ref: DataRef, opts?: FetchOptions): Promise<EfsFile>
  /** Metadata at a path. Returns a discriminated `FileStat` (`{exists:false}` vs
   * `{exists:true; …}`), never `null` — absence is modeled once (review A7). */
  stat(path: string, opts?: ReadOptions): Promise<FileStat>
  list(path: string, opts?: ListOptions): EfsList<DirEntry>
  /** The folder Overview (`README.md`) for `path`, resolved by exact path — never
   * a directory scan (ADR-0011). Returns a discriminated `OverviewResult`
   * (`none` when absent). Folder-scoped: a file path has no Overview. */
  overview(path: string, opts?: OverviewOptions): Promise<OverviewResult>
}

/** Read + write file operations (only present when a `walletClient` is set). */
export type EfsFsWrite = EfsFsRead & {
  write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteReceipt>
  preview(path: string, content: Uint8Array, opts?: PreviewOptions): Promise<WriteEstimate>
  /** Author/replace the folder Overview at `container`: composes the upload
   * pipeline and applies the `system` TAG *before* placement, so an interrupted
   * write never exposes a visible untagged README (ADR-0011). Folder-scoped. */
  setOverview(container: string, markdown: string, opts?: WriteOptions): Promise<WriteReceipt>
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

  // The connected wallet account address, if any — the last-resort default lens
  // for reads (ADR-0039: a read with no explicit lens resolves through the
  // connected wallet, then errors if there is none).
  const account = walletClient?.account?.address

  // Assemble the lens-scoped read context the read verbs operate over. Built fresh
  // per call so a deployment override / account change is always reflected (cheap;
  // the narrow `readContract` surface is the only viem coupling).
  const readContext = (): ReadContext => ({
    publicClient: publicClient as unknown as ReadContext['publicClient'],
    deployment: getDeployment(),
    ...(config.defaultLens !== undefined ? { defaultLens: config.defaultLens } : {}),
    ...(account !== undefined ? { account } : {}),
  })

  return {
    fs: {
      // `async` so a synchronous throw from `readContext()` (e.g. DeploymentNotFound)
      // surfaces as a rejected promise, not a sync throw at the call site.
      read: async (path, opts) => resolveRead(readContext(), path, opts),
      cat: async (path, opts) => catRead(readContext(), path, opts),
      fetch: async (ref, opts) => fetchRef(readContext(), ref, opts),
      stat: async (path, opts) => statRead(readContext(), path, opts),
      // `list` is synchronous (returns a lazy EfsList). Defer deployment + lens +
      // anchor resolution into the first read so the sync method never throws and a
      // bad deployment surfaces on `.page()`/iteration (consistent with the async
      // verbs). The thunk is evaluated inside `listRead`'s lazy `prime()`.
      list: (path, opts) => listRead(readContext, path, opts),
      overview: async (_path, _opts) => {
        throw new NotImplemented('efs.fs.overview()')
      },
      write: async (path, content, opts) => {
        requireWallet()
        // requireWallet() guarantees `walletClient` is defined here.
        const wallet = walletClient as WalletClient
        // Tier-1 (any-wallet, multi-signature) write: one multiAttest per DAG
        // layer. The Tier-2 one-signature path (7702/5792 via @efs/solidity) is a
        // later slice; both consume the same `buildFileWriteGraph` plan.
        //
        // The orchestrator takes the *narrow* client surfaces it needs (typed
        // `readContract`/`writeContract` for the EFS ABIs). viem's full clients
        // satisfy those calls at runtime, but their broadly-generic method
        // signatures don't structurally unify with the narrow interfaces at the
        // type level — so cast through `FileWriteContext` at this boundary.
        const ctx = {
          publicClient,
          walletClient: wallet,
          deployment: getDeployment(),
          // viem binds `account`/`chain` on a wallet client built from the
          // provider/account config; forward them so `writeContract` has them.
          account: wallet.account,
          chain: wallet.chain,
        } as unknown as FileWriteContext
        return writeFileTier1(path, content, ctx, opts)
      },
      preview: async (_path, _content) => {
        throw new NotImplemented('efs.fs.preview()')
      },
      setOverview: async (_container, _markdown, _opts) => {
        requireWallet()
        throw new NotImplemented('efs.fs.setOverview()')
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
  parseSchemaParameters,
  easAbi,
  schemaRegistryAbi,
  EFS_SCHEMA_FIELDS,
  type AttestationRequest,
  type AttestationRequestData,
  type MultiAttestationRequest,
  type EfsSchemaName,
} from './eas/index.js'
export {
  hashContent,
  verifyContent,
  asContentHash,
  type ContentHash,
  type VerificationStatus,
} from './content/hash.js'
// Off-chain fetch/verify/mirror engine (freeze-independent; see future-proofing.md §2).
export * from './mirror/index.js'
// Write path: pure graph builder + Tier-1 submitter (writes/index barrels both).
export * from './writes/index.js'
export { lens, identity, resolveLens, MAX_LENSES, type Lens } from './lenses/resolve.js'
export {
  deployments,
  resolveDeployment,
  assertDeploymentIntegrity,
  type DeploymentsMap,
  type EfsDeployment,
  type EfsContracts,
  type EfsSchemaUIDs,
  type EfsTransports,
} from './chain/deployments.js'
export * from './errors.js'
export type {
  DataRef,
  DataUID,
  DirEntry,
  ReadOptions,
  ListOptions,
  FetchOptions,
  TransportName,
  WriteOptions,
  PreviewOptions,
  Page,
  EfsList,
  ReadResult,
  EfsFile,
  FileStat,
  OverviewResult,
  OverviewOptions,
  WriteReceipt,
  WriteMechanism,
  CallStatus,
  WriteEstimate,
  OperationResult,
  OperationKind,
  BatchReceipt,
} from './types.js'
// Overview convention constants (values, ADR-0011).
export { OVERVIEW_NAME, SAFETY_EXCLUDES, MAX_RENDER_BYTES } from './types.js'
// Vendored contract ABIs (view + resolvers) for reads + writes (ADR-0010/0011).
export * from './chain/abi/index.js'
export {
  MAX_ATTESTERS_PER_QUERY,
  MAX_EXCLUDE_TAGS_PER_QUERY,
  shouldUseFilteredQuery,
  reconcileMinWeights,
  validateDirectoryQuery,
  InvalidDirectoryQuery,
} from './reads/directory.js'
// Path resolution (write-path parent lookup; read-path single-segment walk).
export {
  resolvePathToAnchor,
  resolveParentAnchor,
  splitPath,
  ParentNotFoundError,
  type ResolvePublicClient,
} from './reads/resolve.js'
// Lens-scoped read engine (resolve/stat/cat/fetch/list internals + context).
export {
  type ReadContext,
  type ReadPublicClient,
  type FileSystemItem,
  type DirectoryPageRaw,
  resolveAttesters,
} from './reads/context.js'
export { resolve, stat, resolvePlacement, readReservedProperty } from './reads/file.js'
export { cat, fetchRef } from './reads/fetch.js'
export { list, DEFAULT_PAGE_SIZE } from './reads/list.js'
