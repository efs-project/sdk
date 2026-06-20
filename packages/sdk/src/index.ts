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
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
} from 'viem'
import {
  type DeploymentsMap,
  type EfsDeployment,
  resolveDeployment,
  verifyDeployment,
} from './chain/deployments.js'
import { type DecodedAttestation, decodeAttestation } from './decode.js'
import {
  type AttestationRequest,
  type MultiAttestationRequest,
  SchemaEncoder,
  computeAttestationUID,
  easAbi,
  schemaRegistryAbi,
  verifyAttestationUID,
} from './eas/index.js'
import { type EasVerbs, type RevocationRequest, makeEasVerbs } from './eas/verbs.js'
import { EfsError, NotImplemented, WalletRequired } from './errors.js'
import { toJSON } from './json.js'
import { type Lens, identity, lens, resolveLens } from './lenses/resolve.js'
import { type EfsRawContracts, buildRawContracts } from './raw/contracts.js'
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
import {
  getList as getListRead,
  listEntries as listEntriesRead,
  listHas as listHasRead,
  listLength as listLengthRead,
} from './reads/lists.js'
import { overview as overviewRead } from './reads/overview.js'
import { resolvePathToAnchor } from './reads/resolve.js'
import {
  type SortInfo,
  type SortReadOptions,
  applySort as applySortRead,
  getSort as getSortRead,
} from './reads/sorts.js'
import type {
  AccountCapabilities,
  Attestation,
  BatchReceipt,
  DataRef,
  DirEntry,
  EfsFile,
  EfsList,
  ExpandToken,
  Expanded,
  FetchOptions,
  FileInfo,
  ListConfig,
  ListEntry,
  ListGetOptions,
  ListOptions,
  ListReadOptions,
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
import { type DetectClient, detectAccount, toCapabilities } from './writes/detect.js'
import type { EdgeSubmitContext } from './writes/edge-submit.js'
import { type FileWriteContext, writeFileTier1 } from './writes/file.js'
import { type ListsWriteNs, makeListsWriteNs } from './writes/lists.js'
import { type MirrorsNs, makeMirrorsNs } from './writes/mirrors.js'
import { setOverview as setOverviewWrite } from './writes/overview.js'
import { type PinsNs, makePinsNs } from './writes/pins.js'
import { type PropsNs, makePropsNs } from './writes/props.js'
import { type RedirectsNs, makeRedirectsNs } from './writes/redirects.js'
import { type TagsNs, makeTagsNs } from './writes/tags.js'

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

/**
 * The `efs.lists.*` namespace — read surface for curated collections (LISTs;
 * ADR-0044/0046). Reads only; the write primitives are authored via the Solidity
 * SDK / EAS verbs. Available on read-only and write clients alike (no wallet needed).
 *
 *   - `get(listUID, { lens? })` — the LIST config + identity (`getMode`). NOT
 *     lens-scoped (the config is the curator's declaration); `exists:false` when
 *     absent (a probe — never throws on absence).
 *   - `entries(listUID, { lens?, limit?, cursor? })` — the lens-scoped, ordered,
 *     deduped entries as an {@link EfsList} (first-attester-wins; dedupe honors the
 *     list's `allowsDuplicates`; target decoded per `targetType`). Throws
 *     `ListNotFound` (on first read) when no LIST exists.
 *   - `length(listUID, { lens? })` / `has(listUID, target, { lens? })` — O(1) count
 *     and membership for the resolved lens attester. Both throw `ListNotFound`.
 */
export type EfsListsNs = {
  get(listUID: Hex, opts?: ListGetOptions): Promise<ListConfig>
  entries(listUID: Hex, opts?: ListReadOptions): EfsList<ListEntry>
  length(listUID: Hex, opts?: ListReadOptions): Promise<bigint>
  has(listUID: Hex, target: Address | Hex, opts?: ListReadOptions): Promise<boolean>
}

/**
 * The write-capable `efs.lists.*` namespace — the read verbs plus the LIST write
 * primitives (`create`/`add`/`remove`), present only on a write-capable client (they
 * author attestations as the connected wallet). Mirrors the Solidity `EFSLib`
 * wrappers' encodings and routes through the same Submitter seam as `fs.write`.
 *
 *   - `create(config)` → `WriteReceipt & { listUID }` — mint a LIST (one signature);
 *     validates the resolver invariants client-side BEFORE submit.
 *   - `add(listUID, target, { targetType? })` → `WriteReceipt` — add a LIST_ENTRY,
 *     routed by the list's targetType (read once, or hinted to skip the read).
 *   - `remove(entryUID, { listUID? })` → `Hex` — revoke a LIST_ENTRY; rejects an
 *     append-only list up front (typed error, no chain round-trip) when `listUID` is
 *     supplied.
 */
export type EfsListsWriteNs = EfsListsNs & ListsWriteNs

/**
 * The `efs.sorts.*` namespace — read surface for SORT overlays (sorted views over
 * kernel child arrays).
 *
 * @experimental — DEFERRED. SORT_INFO is not yet in the frozen schema set /
 * deployments registry, so every verb throws `NotImplemented` with a pointer (the
 * on-chain encoding could still change; the SDK does not guess it). The namespace +
 * signatures are present so the real implementation lands additively. Use
 * `efs.lists.*` for curated ordering today.
 */
export type EfsSortsNs = {
  /** @experimental — throws `NotImplemented` until SORT_INFO is frozen + deployed. */
  get(sortInfoUID: Hex, opts?: SortReadOptions): Promise<SortInfo>
  /** @experimental — throws `NotImplemented` until SORT_INFO is frozen + deployed. */
  apply(parentAnchor: Hex, sortInfoUID: Hex, opts?: SortReadOptions): Promise<never>
}

/**
 * The `efs.account.*` namespace (sdk-wallet-architecture §Public surface) —
 * read-by-default account introspection over the execution seam. Present only on a
 * write-capable client (it answers questions about the SIGNING account). Today just
 * the curated capability read; `foreignDelegation()`/`revokeDelegation()` land with
 * the deferred AA slice.
 */
export type EfsAccountNs = {
  /**
   * The curated {@link AccountCapabilities} for the connected signing account
   * (`canOneSig`/`gasless`/`sponsored`/`kind`). Runs `detectAccount` lazily
   * (`getCode` + the wallet's `getCapabilities` when supported) and caches the
   * profile per `(address, chainId)`, so this is NOT on the write hot path — a
   * `fs.write` never triggers it. Tolerant of a wallet without `getCapabilities`.
   */
  capabilities(): Promise<AccountCapabilities>
}

/** Read-capable EAS namespace: the pure tools + raw `getAttestation` (no wallet). */
export type EfsEasReadNs = {
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
  /** Raw EAS read: `getAttestation(uid)` → the typed {@link Attestation}, or
   * `undefined` when the UID is absent (the zero record). Available always. */
  getAttestation: EasVerbs['getAttestation']
}

/** Full EAS namespace (a `walletClient` was supplied): read tools + the raw write
 * verbs (`attest`/`multiAttest`/`revoke`), each routed through `classifyError`. */
export type EfsEasNs = EfsEasReadNs & {
  /** Submit one `attest` over the connected wallet; resolves to the tx hash. */
  attest: EasVerbs['attest']
  /** Submit one `multiAttest` (grouped by schema); resolves to the tx hash. */
  multiAttest: EasVerbs['multiAttest']
  /** Revoke an attestation (only the original attester may); resolves to the tx hash. */
  revoke: EasVerbs['revoke']
}

/** The `efs.decode` bridge: raw {@link Attestation} (or a UID) → the SDK's typed,
 * discriminated view. Synchronous when given an attestation (pure); async when
 * given a UID (reads `getAttestation` first, then decodes). */
export type EfsDecodeNs = {
  /** Decode an already-read raw attestation into the typed view (pure, sync). */
  (attestation: Attestation): DecodedAttestation
  /** Read `getAttestation(uid)` then decode; `null` when the UID is absent. */
  (uid: Hex): Promise<DecodedAttestation | null>
}

/** Read-capable `raw` namespace: the deployment + the pre-wired read-only contract
 * instances (write methods absent until a wallet is supplied — see {@link EfsRawNs}). */
export type EfsRawReadNs = EfsRawContracts & {
  deployment(): EfsDeployment
  /**
   * Run the full deployment trust gate: bytecode presence **then** schema-UID
   * authenticity (each of the nine frozen UIDs is read from its authoritative
   * on-chain getter and compared to the registry; ADR-0005 / review P1 #9).
   * Opt-in — call it once after wiring a custom `deployments` override.
   * Resolves on success; rejects with `EfsError` (no bytecode) or
   * `SchemaMismatchError` (a UID the deployment claims doesn't match chain).
   */
  verifyDeployment(): Promise<void>
}

/** The `raw` namespace. Same shape read or write — the contract instances carry
 * `.write.*` only when a wallet was supplied (viem's own getContract split). */
export type EfsRawNs = EfsRawReadNs

/** Read-capable client (no `walletClient`). The `eas`/`raw` escape hatches are
 * read-only here (no write verbs / no `.write.*` on the raw instances). */
export type EfsReadClient = {
  fs: EfsFsRead
  lenses: EfsLensesNs
  /** Curated-collection reads (`efs.lists.*`); no wallet required. */
  lists: EfsListsNs
  /** SORT overlay reads (`efs.sorts.*`); @experimental — deferred, throws today. */
  sorts: EfsSortsNs
  eas: EfsEasReadNs
  raw: EfsRawReadNs
  /** Round-trip bridge: raw {@link Attestation} (or a UID) → the typed view. */
  decode: EfsDecodeNs
  /**
   * Serialize an EFS result to a JSON string with `bigint`s (file `size`, tag
   * weights, list `maxEntries`, estimate `gas`, …) rendered as decimal strings —
   * bare `JSON.stringify` THROWS on a bigint. Convenience over the exported
   * {@link jsonReplacer}; see its note on the lossy round-trip (bigints come back as
   * strings, not bigints). Pure + stateless; present on read-only clients too.
   */
  toJSON(value: unknown, space?: number | string): string
}

/**
 * The `efs.graph.*` namespace — the standalone graph-edge write primitives that sit
 * alongside `fs.write` (completeness P1-1). Present only on a write-capable client
 * (they author attestations as the connected wallet). `tags` is the TAG edge
 * (add/remove + reads); `pins` is the cardinality-1 placement PIN (place/unplace +
 * the active read). Both route through the same Submitter seam as `fs.write`.
 */
export type EfsGraphNs = {
  tags: TagsNs
  pins: PinsNs
}

/** Full client (a `walletClient` was supplied): reads + writes + batching. The
 * `eas` namespace gains the raw write verbs; `raw` instances gain `.write.*`. */
export type EfsClient = EfsReadClient & {
  fs: EfsFsWrite
  eas: EfsEasNs
  raw: EfsRawNs
  /** Account introspection over the execution seam (read-by-default). */
  account: EfsAccountNs
  /** Standalone graph-edge writes: `graph.tags.*` (TAG) + `graph.pins.*` (PIN). */
  graph: EfsGraphNs
  /** Standalone PROPERTY value writes: `props.{set,get,list}`. */
  props: PropsNs
  /** Standalone MIRROR (retrieval-method) writes: `mirrors.{add,remove,list}` — add a
   * retrieval URI to an existing DATA (file-write publishes mirrors inline; this is the
   * after-the-fact verb). */
  mirrors: MirrorsNs
  /** REDIRECT (alias) primitive (ADR-0050): `redirects.{set,remove,get}` — the
   * trust-scoped "this points at that" edge (canonical/dedup, version supersession,
   * symlinks). Read-time *following* of an alias chain is on `efs.fs.locate`/`read`
   * via `{ followRedirects }`; this namespace is the write verbs + the literal
   * active-record read. */
  redirects: RedirectsNs
  /** Curated-collection reads + writes (`efs.lists.*`): the read verbs plus
   * `create`/`add`/`remove` (LIST / LIST_ENTRY). */
  lists: EfsListsWriteNs
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

  // The `efs.raw.*` pre-wired contract instances (P1-4): viem `getContract`s bound
  // to the resolved deployment addresses + vendored ABIs + the client(s). Built once
  // (the instances re-resolve the deployment lazily on each property access).
  const rawContracts = buildRawContracts(getDeployment, {
    public: publicClient,
    wallet: walletClient,
  })

  // The `efs.eas.*` raw verb implementations (attest/multiAttest/revoke/getAttestation)
  // over the EAS address from the resolved deployment, routed through classifyError.
  const easVerbs: EasVerbs = makeEasVerbs({
    get easAddress() {
      return getDeployment().contracts.eas
    },
    publicClient: publicClient as unknown as Parameters<typeof makeEasVerbs>[0]['publicClient'],
    walletClient: walletClient as unknown as Parameters<typeof makeEasVerbs>[0]['walletClient'],
    requireWallet,
    ...(walletClient?.account !== undefined ? { account: walletClient.account } : {}),
    ...(walletClient?.chain !== undefined ? { chain: walletClient.chain } : {}),
  })

  // Build the edge/value submit context (TAG / PROPERTY / PIN writes) — the file
  // write's chain/wallet plumbing plus the attester the receipt records. Built per
  // call so a deployment override / account change is reflected. Only ever invoked
  // on a write-capable client (the namespaces are wallet-gated below).
  const edgeSubmitContext = (): EdgeSubmitContext => {
    const wallet = walletClient as WalletClient
    const dep = getDeployment()
    const attester = wallet.account?.address
    if (attester === undefined) {
      throw new EfsError(
        'efs.graph/props write: the wallet client has no bound account — cannot author as an attester.',
        { code: 'WalletRequired' },
      )
    }
    return {
      // The submit path uses `writeContract` (wallet) + `waitForTransactionReceipt`
      // (public); supply each from its client. viem's broadly-generic method
      // signatures don't structurally unify with the narrow submit surfaces at the
      // type level, so cast through them at this boundary (same as `fs.write`).
      walletClient: wallet as unknown as EdgeSubmitContext['walletClient'],
      publicClient: publicClient as unknown as EdgeSubmitContext['publicClient'],
      easAddress: dep.contracts.eas,
      chainId: dep.chainId,
      attester,
      ...(wallet.account !== undefined ? { account: wallet.account } : {}),
      ...(wallet.chain !== undefined ? { chain: wallet.chain } : {}),
    }
  }

  // The standalone graph-edge / value namespaces (completeness P1-1). Built once,
  // bound to the lazy deployment + the clients; the deps re-resolve on each call.
  // Revokes go through the `efs.eas.revoke` verb (the same typed funnel).
  const tagsNs = makeTagsNs({
    getDeployment,
    publicClient: publicClient as unknown as ReadContext['publicClient'],
    submitContext: edgeSubmitContext,
    attester: () => account,
    revoke: (schema, uid) => easVerbs.revoke({ schema, uid }),
  })
  const pinsNs = makePinsNs({
    getDeployment,
    publicClient: publicClient as unknown as ReadContext['publicClient'],
    submitContext: edgeSubmitContext,
    attester: () => account,
    revoke: (schema, uid) => easVerbs.revoke({ schema, uid }),
  })
  const propsNs = makePropsNs({
    getDeployment,
    publicClient: publicClient as unknown as ReadContext['publicClient'],
    readContext,
    submitContext: edgeSubmitContext,
    attester: () => account,
  })
  // The `efs.mirrors.*` write verbs (add/remove) + the lens-scoped list read. Same
  // wiring as graph/props: built once, gated at the type level, revokes through the
  // `efs.eas.revoke` funnel; the transport anchor is resolved on `add` via the
  // public client (deployment map → /transports/<scheme> path fallback).
  const mirrorsNs = makeMirrorsNs({
    getDeployment,
    publicClient: publicClient as unknown as ReadContext['publicClient'],
    submitContext: edgeSubmitContext,
    attester: () => account,
    revoke: (schema, uid) => easVerbs.revoke({ schema, uid }),
  })
  // The `efs.redirects.*` write verbs (set/remove) + the literal active-record read
  // (get). Like graph/props, merged unconditionally and gated at the type level; a
  // no-wallet runtime call to set/remove throws via the wallet-bound submit/revoke.
  const redirectsNs = makeRedirectsNs({
    getDeployment,
    readContext,
    submitContext: edgeSubmitContext,
    revoke: (schema, uid) => easVerbs.revoke({ schema, uid }),
  })
  // The `efs.lists.*` write verbs (create/add/remove). Merged onto the read verbs
  // below; the type-level write gate hides them on a read-only client, and each
  // verb authors through the wallet-bound submit/revoke (a no-wallet runtime call
  // throws). `add`/`remove` reuse the read engine's `getList` (config routing).
  const listsWriteNs = makeListsWriteNs({
    getDeployment,
    publicClient: publicClient as unknown as ReadContext['publicClient'],
    readContext,
    submitContext: edgeSubmitContext,
    revoke: (schema, uid) => easVerbs.revoke({ schema, uid }),
  })

  // `efs.decode` (P1-4): raw Attestation → typed view (sync, pure), or a UID →
  // read-then-decode (async; `null` when the UID is absent). One overloaded fn.
  const decode = ((
    input: Attestation | Hex,
  ): DecodedAttestation | Promise<DecodedAttestation | null> => {
    if (typeof input === 'string') {
      return easVerbs.getAttestation(input).then((att) => {
        if (att === undefined) return null
        return decodeAttestation(att, getDeployment())
      })
    }
    return decodeAttestation(input, getDeployment())
  }) as EfsDecodeNs

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
      // Folder Overview (ADR-0011): the folder's README.md, resolved by EXACT path
      // (never a directory scan) and classified into a discriminated OverviewResult.
      overview: async (path, opts) => overviewRead(readContext(), path, opts),
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
      // Author/replace the folder Overview (ADR-0011): the normal file-write pipeline
      // at `${container}/README.md`, forced to `text/markdown`, with the `system` TAG
      // applied on the README's own anchor BEFORE the placement PIN (no untagged
      // flash). Same wallet/chain plumbing as `write`, plus an indexer-backed
      // `resolveAnchorPath` so the orchestrator can resolve the `/tags/system` def.
      setOverview: async (container, markdown, opts) => {
        requireWallet()
        const wallet = walletClient as WalletClient
        const dep = getDeployment()
        const baseCtx = {
          publicClient,
          walletClient: wallet,
          deployment: dep,
          account: wallet.account,
          chain: wallet.chain,
          ...(config.write?.onchainAutoLimit !== undefined
            ? { onchainAutoLimit: config.write.onchainAutoLimit }
            : {}),
        } as unknown as FileWriteContext
        const overviewCtx = {
          ...baseCtx,
          resolveAnchorPath: (path: string) =>
            resolvePathToAnchor(
              publicClient as unknown as Parameters<typeof resolvePathToAnchor>[0],
              dep.contracts.indexer,
              path,
            ),
        }
        return setOverviewWrite(container, markdown, overviewCtx, opts)
      },
    },
    lenses: {
      resolve: (input) => resolveLens(input, { publicClient }),
      lens,
      identity,
    },
    // Curated-collection reads (`efs.lists.*`). `get`/`length`/`has` are async over
    // the read context; `entries` is synchronous (a lazy EfsList) — defer the context
    // into a thunk so the synchronous call never throws (mirrors `fs.list`).
    // Read verbs always; the write verbs (create/add/remove) are merged on
    // unconditionally and gated at the type level (EfsListsWriteNs on EfsClient vs
    // EfsListsNs on EfsReadClient), like graph/props — a no-wallet runtime call to a
    // write verb throws via the wallet-bound submit/revoke.
    lists: {
      get: (listUID, opts) => getListRead(readContext(), listUID, opts),
      entries: (listUID, opts) => listEntriesRead(readContext, listUID, opts),
      length: (listUID, opts) => listLengthRead(readContext(), listUID, opts),
      has: (listUID, target, opts) => listHasRead(readContext(), listUID, target, opts),
      create: (config) => listsWriteNs.create(config),
      add: (listUID, target, opts) => listsWriteNs.add(listUID, target, opts),
      remove: (entryUID, opts) => listsWriteNs.remove(entryUID, opts),
    },
    // SORT overlay reads (`efs.sorts.*`). @experimental — every verb throws
    // NotImplemented until SORT_INFO is frozen + deployed (see reads/sorts.ts).
    sorts: {
      get: (sortInfoUID, opts) => getSortRead(sortInfoUID, opts),
      apply: (parentAnchor, sortInfoUID, opts) => applySortRead(parentAnchor, sortInfoUID, opts),
    },
    eas: {
      encoder: (schema) => new SchemaEncoder(schema),
      computeUID: computeAttestationUID,
      verifyUID: verifyAttestationUID,
      abi: { eas: easAbi, schemaRegistry: schemaRegistryAbi },
      attestationsFor: (items, opts) => attestationsForItems(readContext(), items, opts),
      // Raw EAS verbs (P1-4): reads available always, writes gated on the wallet.
      getAttestation: easVerbs.getAttestation,
      attest: easVerbs.attest,
      multiAttest: easVerbs.multiAttest,
      revoke: easVerbs.revoke,
    },
    raw: {
      deployment: getDeployment,
      verifyDeployment: () => verifyDeployment(publicClient, getDeployment()),
      // Spread the pre-wired contract instances (P1-4). They are lazy getters, so
      // spreading here would eagerly resolve them — instead expose the object so
      // each `efs.raw.<contract>` access re-resolves the deployment.
      get indexer() {
        return rawContracts.indexer
      },
      get router() {
        return rawContracts.router
      },
      get fileView() {
        return rawContracts.fileView
      },
      get edgeResolver() {
        return rawContracts.edgeResolver
      },
      get mirrorResolver() {
        return rawContracts.mirrorResolver
      },
      get listReader() {
        return rawContracts.listReader
      },
      get aliasResolver() {
        return rawContracts.aliasResolver
      },
      get eas() {
        return rawContracts.eas
      },
    },
    decode,
    toJSON,
    account: {
      capabilities: async () => {
        requireWallet()
        const wallet = walletClient as WalletClient
        const address = wallet.account?.address
        if (address === undefined) {
          throw new EfsError(
            'efs.account.capabilities(): the wallet client has no bound account — cannot profile the signing account.',
            { code: 'WalletRequired' },
          )
        }
        // Compose the narrow DetectClient: `getCode` from the public client, the
        // optional EIP-5792 `getCapabilities` from the wallet (absent on wallets
        // that don't implement it — detection tolerates that). Lazy + cached per
        // (address, chainId); never on the write hot path.
        const detectClient: DetectClient = {
          getCode: (args) => (publicClient as unknown as DetectClient).getCode(args),
          ...(typeof (wallet as unknown as DetectClient).getCapabilities === 'function'
            ? {
                getCapabilities: (args) =>
                  (wallet as unknown as Required<DetectClient>).getCapabilities(args),
              }
            : {}),
        }
        const profile = await detectAccount(detectClient, address, chainIdOf(publicClient))
        return toCapabilities(profile)
      },
    },
    // Standalone graph-edge / value write namespaces (completeness P1-1). Present on
    // the returned object unconditionally; the type-level write gate (`EfsClient` vs
    // `EfsReadClient`) hides them on a read-only client, and each write verb authors
    // through the wallet-bound submit/revoke (so a no-wallet runtime call throws).
    graph: { tags: tagsNs, pins: pinsNs },
    props: propsNs,
    mirrors: mirrorsNs,
    redirects: redirectsNs,
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
  revokeAbi,
  schemaRegistryAbi,
  EFS_SCHEMA_FIELDS,
  type AttestationRequest,
  type AttestationRequestData,
  type MultiAttestationRequest,
  type EfsSchemaName,
} from './eas/index.js'
// Raw EAS verbs (`efs.eas.attest/multiAttest/revoke/getAttestation`) — escape hatch (P1-4).
export {
  makeEasVerbs,
  type EasVerbs,
  type EasVerbContext,
  type EasWalletClient,
  type EasPublicClient,
  type RevocationRequest,
} from './eas/verbs.js'
// `efs.raw.*` pre-wired contract instances — escape hatch (P1-4).
export { buildRawContracts, type EfsRawContracts, type RawClients } from './raw/contracts.js'
// `efs.decode` round-trip bridge — raw Attestation → typed view (P1-4).
export {
  decodeAttestation,
  type DecodedAttestation,
  type DecodedKnown,
  type DecodedUnknown,
  type DecodedAnchor,
  type DecodedProperty,
  type DecodedData,
  type DecodedPin,
  type DecodedTag,
  type DecodedMirror,
  type DecodedList,
  type DecodedListEntry,
  type DecodedRedirect,
} from './decode.js'
export {
  hashContent,
  verifyContent,
  asContentHash,
  type ContentHash,
  type VerificationStatus,
} from './content/hash.js'
// Bigint-safe JSON serialization for EFS result DTOs (`efs.toJSON`) — review P3 DX.
export { toJSON, jsonReplacer } from './json.js'
// Off-chain fetch/verify/mirror engine (freeze-independent; see future-proofing.md §2).
export * from './mirror/index.js'
// Write path: pure graph builder + Tier-1 submitter (writes/index barrels both).
export * from './writes/index.js'
export { lens, identity, resolveLens, MAX_LENSES, type Lens } from './lenses/resolve.js'
export {
  deployments,
  resolveDeployment,
  assertDeploymentIntegrity,
  assertSchemaIntegrity,
  verifyDeployment,
  type DeploymentsMap,
  type EfsDeployment,
  type EfsContracts,
  type EfsSchemaUIDs,
  type EfsTransports,
} from './chain/deployments.js'
export * from './errors.js'
export type {
  AccountProfile,
  AccountCapabilities,
  AnchorUID,
  DataRef,
  DataUID,
  DirEntry,
  ReadOpts,
  ReadOptions,
  ExpandToken,
  Expanded,
  ListOptions,
  ListConfig,
  ListEntry,
  ListTargetType,
  ListReadOptions,
  ListGetOptions,
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
  planExistingAncestorVisibilityTags,
  splitPath,
  ParentNotFoundError,
  type ParentPlan,
  type ResolvePublicClient,
  type TagReadPublicClient,
  type VisibilityTagPlanInput,
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
// Folder Overview read (`efs.fs.overview`) — exact-path README.md resolution (ADR-0011).
export { overview } from './reads/overview.js'
// Folder Overview write (`efs.fs.setOverview`) — README.md + system-TAG-before-placement (ADR-0011).
export {
  setOverview,
  overviewPath,
  SYSTEM_TAG_PATH,
  type OverviewWriteContext,
} from './writes/overview.js'
// Curated-collection (LIST) reads — `efs.lists.*` internals (ADR-0044/0046).
export {
  getList,
  listEntries,
  listLength,
  listHas,
  DEFAULT_LIST_PAGE_SIZE,
} from './reads/lists.js'
// SORT overlay reads — `efs.sorts.*`. @experimental (deferred; throws until frozen).
export {
  getSort,
  applySort,
  type SortInfo,
  type SortSourceType,
  type SortReadOptions,
} from './reads/sorts.js'
// REDIRECT (alias) — read-time resolution engine (ADR-0050).
export {
  readActiveRedirect,
  followRedirectChain,
  resolveHopCap,
  redirectKindName,
  isAutoFollowedKind,
  DEFAULT_REDIRECT_HOPS,
  MAX_REDIRECT_HOPS,
  type RedirectFollowResult,
} from './reads/redirects.js'
// REDIRECT (alias) — `efs.redirects.*` write verbs + plan builder + kind constants.
export {
  makeRedirectsNs,
  type RedirectsNs,
  type RedirectSetOptions,
  type RedirectGetOptions,
} from './writes/redirects.js'
export type { RedirectKind, RedirectRecord } from './types.js'
