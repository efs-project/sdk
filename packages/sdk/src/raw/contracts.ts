/**
 * `efs.raw.*` — pre-wired viem contract instances bound to the resolved deployment
 * addresses + the vendored ABIs + the client (P1-4 escape hatch). This is the
 * "drop to the raw layer" surface: a dev who needs an on-chain method the typed
 * SDK doesn't (yet) expose can call it directly, fully typed, against the right
 * address — no manual address/ABI plumbing.
 *
 * Each instance is a viem `getContract(...)`: its read methods (`.read.fn(args)`)
 * are available whenever a public client is present (always); its write methods
 * (`.write.fn(args)`) are present only when a wallet client was supplied — viem's
 * own read/write split mirrors the SDK's type-level write gate, so a read-only
 * client's raw instances simply have no `.write` surface.
 *
 * The instances are exposed as lazy getters: the deployment is resolved on each
 * property access, so a `deployments` override / chain change is always reflected
 * and a missing deployment surfaces as the same `DeploymentNotFound` the rest of
 * the SDK throws — at the point of use, never at client construction.
 */

import { type GetContractReturnType, type PublicClient, type WalletClient, getContract } from 'viem'
import {
  aliasResolverAbi,
  edgeResolverAbi,
  fileViewAbi,
  indexerAbi,
  listReaderAbi,
  mirrorResolverAbi,
  routerAbi,
} from '../chain/abi/index.js'
import type { EfsDeployment } from '../chain/deployments.js'
import { easAbi } from '../eas/abi.js'

/**
 * The viem clients a raw contract instance binds to. When `wallet` is present the
 * instances expose `.write.*`; otherwise read-only (`.read.*`). Kept as the broad
 * viem client types so `getContract` infers the full typed method surface.
 */
export type RawClients = {
  public: PublicClient
  wallet: WalletClient | undefined
}

/** The wallet-backed client shape (`.write.*` present on every instance). */
type RawWriteClient = { public: PublicClient; wallet: WalletClient }
/** The read-only client shape (NO `.write.*` — viem generates none without a
 * wallet, and the type must say so: a `wallet?:` optional here would make viem
 * include the write surface on the READ type, letting a no-wallet client
 * type-check `raw.eas.write.revoke(...)` that is `undefined` at runtime). */
type RawReadClient = { public: PublicClient }

/**
 * One pre-wired instance per EFS/EAS contract the SDK vendors an ABI for,
 * parameterized by the client shape so the read-only and wallet-backed
 * namespaces get DISTINCT viem-inferred surfaces. The concrete
 * `GetContractReturnType` is what viem infers from each `as const` ABI + the
 * client type — the same surface a dev would get from `getContract` by hand.
 */
type RawContractsFor<C extends RawReadClient> = {
  /** EFS Indexer (kernel reads + the frozen schema-UID getters). */
  indexer: GetContractReturnType<typeof indexerAbi, C>
  /** EFS Router (request classification / resolve mode). */
  router: GetContractReturnType<typeof routerAbi, C>
  /** EFSFileView (directory pages, path resolution, data-mirror reads). */
  fileView: GetContractReturnType<typeof fileViewAbi, C>
  /** EdgeResolver (active PIN/TAG edge reads). */
  edgeResolver: GetContractReturnType<typeof edgeResolverAbi, C>
  /** MirrorResolver (transport anchors, max-URI length). */
  mirrorResolver: GetContractReturnType<typeof mirrorResolverAbi, C>
  /** ListReader (list mode / entries / membership reads). */
  listReader: GetContractReturnType<typeof listReaderAbi, C>
  /** AliasResolver (REDIRECT schema UID + redirect resolution). */
  aliasResolver: GetContractReturnType<typeof aliasResolverAbi, C>
  /** The external EAS contract (attest/multiAttest/revoke/getAttestation). */
  eas: GetContractReturnType<typeof easAbi, C>
}

/** The wallet-backed raw instances (`.read.*` AND `.write.*`). */
export type EfsRawContracts = RawContractsFor<RawWriteClient>
/** The read-only raw instances — `.write.*` is ABSENT at the type level, so a
 * no-wallet client cannot type-check a write that would be a runtime
 * `TypeError` (the documented wallet gate, made real). */
export type EfsRawReadContracts = RawContractsFor<RawReadClient>

/** Build the `{ public, wallet? }` arg viem's `getContract` expects, wallet omitted
 * for a read-only client (so no `.write` surface is generated). */
function clientArg(clients: RawClients): RawReadClient | RawWriteClient {
  return clients.wallet
    ? { public: clients.public, wallet: clients.wallet }
    : { public: clients.public }
}

/**
 * Build the `efs.raw.*` contract instances for a deployment. `getDeployment` is the
 * client's lazy resolver (a missing deployment throws `DeploymentNotFound` at
 * access time, not at construct). Each instance is bound to its authoritative
 * address from the CONSTRUCTION-chain deployment: a provider that later drifts
 * to another chain fails closed with `WrongChain` on use (the chain-guarded
 * clients in index.ts) — drift is NOT re-resolved into another chain's
 * deployment. A caller-supplied `deployments` OVERRIDE is reflected (the lazy
 * getters re-read the resolver), which is a different thing from chain drift.
 */
export function buildRawContracts(
  getDeployment: () => EfsDeployment,
  clients: RawClients,
): EfsRawContracts {
  const client = clientArg(clients)
  const at = <const TAbi extends readonly unknown[]>(
    pick: (d: EfsDeployment) => `0x${string}`,
    abi: TAbi,
  ): GetContractReturnType<TAbi, RawWriteClient> =>
    getContract({
      address: pick(getDeployment()),
      abi,
      client,
    }) as unknown as GetContractReturnType<TAbi, RawWriteClient>

  // Lazy getters: each access re-resolves the deployment RECORD (an override is
  // reflected; a missing deployment throws DeploymentNotFound here, not at
  // construct). Chain DRIFT is NOT reflected — the guarded clients fail closed
  // with WrongChain rather than re-pointing at the drifted chain's contracts.
  return {
    get indexer() {
      return at((d) => d.contracts.indexer, indexerAbi)
    },
    get router() {
      return at((d) => d.contracts.router, routerAbi)
    },
    get fileView() {
      return at((d) => d.contracts.fileView, fileViewAbi)
    },
    get edgeResolver() {
      return at((d) => d.contracts.edgeResolver, edgeResolverAbi)
    },
    get mirrorResolver() {
      return at((d) => d.contracts.mirrorResolver, mirrorResolverAbi)
    },
    get listReader() {
      return at((d) => d.contracts.listReader, listReaderAbi)
    },
    get aliasResolver() {
      return at((d) => d.contracts.aliasResolver, aliasResolverAbi)
    },
    get eas() {
      return at((d) => d.contracts.eas, easAbi)
    },
  }
}
