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
import {
  type HasSourceUIDs,
  type HydratedItem,
  attestationsFor as attestationsForItems,
} from './reads/attestations.js'
import type { ReadContext } from './reads/context.js'
import {
  type ParseSchema,
  readBytes as readBytesFile,
  read as readFile,
  readJson as readJsonFile,
  readText as readTextFile,
} from './reads/fetch.js'
import { exists as existsRead, info as infoRead, locate as locateRead } from './reads/file.js'
import { list as listRead } from './reads/list.js'
import type {
  BatchReceipt,
  DataRef,
  DirEntry,
  EfsFile,
  EfsList,
  ExpandToken,
  Expanded,
  FetchOptions,
  FileInfo,
  ListOptions,
  OverviewOptions,
  OverviewResult,
  PreviewOptions,
  ReadOpts,
  ReadResult,
  WriteConfig,
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
  /**
   * Client-level write defaults. Notably `write.onchainAutoLimit` — the byte cap
   * under which a no-mirrors `fs.write` auto-stores the bytes on-chain (SSTORE2 +
   * a `web3://` mirror); over it throws `PayloadTooLarge`. Default 16 KB.
   */
  write?: WriteConfig
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
    // Opt into Multicall3 coalescing for the SDK-constructed client (sdk-read-surface
    // §Batching): viem's `batch.multicall` is OFF by default, so concurrent
    // `readContract`s fired in the same tick (every internal bulk path uses
    // `Promise.all`) coalesce into one aggregate3. NOT imposed on a user-supplied
    // `publicClient` (the ViemConfig path below) — batching is their call there.
    const publicClient = createPublicClient({
      chain: config.chain,
      transport,
      batch: { multicall: true },
    })
    const walletClient =
      config.account !== undefined
        ? createWalletClient({ chain: config.chain, account: config.account, transport })
        : undefined
    return { publicClient, walletClient }
  }
  return { publicClient: config.publicClient, walletClient: config.walletClient }
}

/** Read-only file operations (sdk-read-surface verbs). */
export type EfsFsRead = {
  /** The file's content. Accepts a PATH or a {@link DataRef} (folds in the old
   * `fetch(ref)`). Returns an {@link EfsFile} with `bytes` + pure `.text()`/`.json()`
   * + trust-relative `verification` + `hashAuthor`. Throws `FileNotFoundError` when a
   * PATH resolves to nothing, `Revoked` when the winning record is revoked. Generic
   * over `expand`: `expand:['attestations']` makes `.attestations` non-optional. */
  read<const E extends readonly ExpandToken[] = []>(
    pathOrRef: string | DataRef,
    opts?: ReadOpts<E> & FetchOptions,
  ): Promise<Expanded<EfsFile, E>>
  /** Sugar → the bare UTF-8 string. FAIL-CLOSED: throws `ContentHashMismatch`/
   * `MalformedClaim` on a verification problem unless `{verify:false}`. */
  readText(path: string, opts?: ReadOpts & FetchOptions): Promise<string>
  /** Sugar → the bare bytes. Fail-closed (see {@link EfsFsRead.readText}). */
  readBytes(path: string, opts?: ReadOpts & FetchOptions): Promise<Uint8Array>
  /** Sugar → the parsed JSON value. Fail-closed; optional `schema` (e.g. zod) narrows. */
  readJson<T = unknown>(
    path: string,
    opts?: ReadOpts & FetchOptions & { schema?: ParseSchema<T> },
  ): Promise<T>
  /** The pointer: which DATA/version + winning attester, no bytes. `null` when
   * nothing is placed under the lens (a normal absence). Renamed from `resolve`. */
  locate(path: string, opts?: ReadOpts): Promise<ReadResult | null>
  /** Flat metadata DTO (sdk-read-surface). Always returns a {@link FileInfo}; absence
   * is `exists:false`. Provenance is always present and never projected away; `fields`
   * projects the value payload; `expand` opts into nested records. Generic over
   * `expand`: `expand:['attestations']` makes `.attestations` non-optional. */
  info<const E extends readonly ExpandToken[] = []>(
    path: string,
    opts?: ReadOpts<E>,
  ): Promise<Expanded<FileInfo, E>>
  /** Cheap presence probe. Never throws except on network error (or `LensRequired`). */
  exists(path: string, opts?: ReadOpts): Promise<boolean>
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
  /** Batched hydrate (sdk-read-surface §Trust escalation): one coalesced multicall
   * of `getAttestation(uid)` over every source UID across `items`, `allowFailure`-
   * style (a revoked/absent UID degrades per-item, never failing the batch). Also
   * backs `expand:['attestations']`. */
  attestationsFor(
    items: readonly HasSourceUIDs[],
    opts?: { withSchema?: boolean },
  ): Promise<HydratedItem[]>
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
      // `read`/`info` are generic over the expand tuple at the type level; the
      // runtime impl is monomorphic (returns the wide `EfsFile`/`FileInfo`), so the
      // expand-narrowed return type is a compile-time-only refinement — cast through
      // the typed surface at this boundary (the narrowing is sound: when the token is
      // present the field IS populated; see `info`/`read` + `Expanded`).
      read: (async (pathOrRef: string | DataRef, opts?: ReadOpts & FetchOptions) =>
        readFile(readContext(), pathOrRef, opts)) as EfsFsRead['read'],
      readText: async (path, opts) => readTextFile(readContext(), path, opts),
      readBytes: async (path, opts) => readBytesFile(readContext(), path, opts),
      readJson: async (path, opts) => readJsonFile(readContext(), path, opts),
      locate: async (path, opts) => locateRead(readContext(), path, opts),
      info: (async (path: string, opts?: ReadOpts) =>
        infoRead(readContext(), path, opts)) as EfsFsRead['info'],
      exists: async (path, opts) => existsRead(readContext(), path, opts),
      // `list` is synchronous (returns a lazy EfsList). Defer deployment + lens +
      // anchor resolution into the first read so the sync method never throws and a
      // bad deployment surfaces on `.byPage()`/iteration (consistent with the async
      // verbs). The thunk is evaluated inside `listRead`'s lazy `prime()`.
      list: (path, opts) => listRead(readContext, path, opts),
      overview: async (_path, _opts) => {
        throw new NotImplemented('efs.fs.overview()', {
          alternative:
            "read the folder's README.md directly for now: efs.fs.readText(`${path}/README.md`).",
          tracking: 'ADR-0011',
        })
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
          // Client-level on-chain auto-store cap (default applied in resolveMirrors).
          ...(config.write?.onchainAutoLimit !== undefined
            ? { onchainAutoLimit: config.write.onchainAutoLimit }
            : {}),
        } as unknown as FileWriteContext
        return writeFileTier1(path, content, ctx, opts)
      },
      preview: async (_path, _content) => {
        throw new NotImplemented('efs.fs.preview()', {
          alternative:
            'call efs.fs.write() directly for now — it returns a receipt; pre-flight cost estimation is a later slice.',
        })
      },
      setOverview: async (_container, _markdown, _opts) => {
        requireWallet()
        throw new NotImplemented('efs.fs.setOverview()', {
          alternative:
            "write the folder's README.md directly for now: efs.fs.write(`${container}/README.md`, bytes).",
          tracking: 'ADR-0011',
        })
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
      attestationsFor: (items, opts) => attestationsForItems(readContext(), items, opts),
    },
    raw: {
      deployment: getDeployment,
      verifyDeployment: () => assertDeploymentIntegrity(publicClient, getDeployment()),
    },
    batch: () => {
      requireWallet()
      throw new NotImplemented('efs.batch()', {
        alternative:
          'call fs.write() per file for now — one signature per file; the one-signature batch path is a later slice.',
      })
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
  ReadOpts,
  ReadOptions,
  ExpandToken,
  Expanded,
  ListOptions,
  FetchOptions,
  TransportName,
  WriteOptions,
  PreviewOptions,
  Page,
  EfsList,
  ReadResult,
  EfsFile,
  FileInfo,
  Attestation,
  SchemaRecord,
  FileAttestations,
  SourceUIDs,
  OverviewResult,
  OverviewOptions,
  WriteConfig,
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
  resolveOrPlanParents,
  splitPath,
  ParentNotFoundError,
  type ParentPlan,
  type ResolvePublicClient,
} from './reads/resolve.js'
// Lens-scoped read engine (resolve/stat/cat/fetch/list internals + context).
export {
  type ReadContext,
  type ReadPublicClient,
  type FileSystemItem,
  type DirectoryPageRaw,
  resolveAttesters,
  SYSTEM_LENS,
} from './reads/context.js'
export {
  locate,
  info,
  exists,
  resolvePlacement,
  readReservedProperty,
  type ReservedProperty,
} from './reads/file.js'
export {
  read,
  readText,
  readBytes,
  readJson,
  fetchRef,
  type ParseSchema,
} from './reads/fetch.js'
export {
  attestationsFor,
  attestationsForUIDs,
  attestationFor,
  isRevoked,
  isAbsent,
  type HasSourceUIDs,
  type HydratedItem,
} from './reads/attestations.js'
export { list, DEFAULT_PAGE_SIZE } from './reads/list.js'
