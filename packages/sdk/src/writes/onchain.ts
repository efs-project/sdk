/**
 * On-chain (`web3://` + SSTORE2) zero-infra storage for the write path.
 *
 * The default "save" for a small file when the caller supplies no `mirrors`:
 * deploy the bytes on-chain as a single SSTORE2 chunk + a chunk-manager contract,
 * then publish a `web3://<chunkManager>` MIRROR pointing at it. No IPFS pin, no
 * gateway, no off-chain infra — the bytes live in contract code and the canonical
 * EFSRouter serves them back via `extcodecopy` (the read path in the contracts
 * repo's `EFSRouter.sol` web3:// branch).
 *
 * ## What gets deployed (ported verbatim from the contracts reference)
 *
 * This mirrors `contracts/packages/hardhat/scripts/simulate-transports.ts`
 * (`deploySSTORE2Chunk` + `deployChunkedOnchainURI`), which is the canonical
 * on-chain upload reference the router was built against:
 *
 *   1. **SSTORE2 chunk** — a raw-bytecode contract whose runtime is `0x00 || bytes`
 *      (the leading STOP byte is the SSTORE2 convention; the router skips it on
 *      read). Deployed via a minimal init-code stub, NOT a Solidity contract:
 *        61 LLLL  PUSH2 runtimeLen
 *        80       DUP1
 *        60 0c    PUSH1 0x0c        (12-byte init prefix before the runtime)
 *        60 00    PUSH1 0x00
 *        39       CODECOPY
 *        60 00    PUSH1 0x00
 *        f3       RETURN
 *      then `runtime = 0x00 || content`.
 *
 *   2. **Chunk manager** — an `EFSBytesStore(address[] chunks)` (the contracts
 *      repo's deployable chunk-manager: `chunkCount()` + `chunkAddress(i)`, the
 *      EIP-7617 interface `EFSRouter` probes via `IChunkedSSTORE2`). The compiled
 *      creation bytecode is vendored in `onchain-bytecode.ts` from the contracts
 *      artifact (functionally name-independent — the router reads by interface).
 *
 * The resulting URI is `web3://<chunkManagerAddress>` — EXACTLY the shape
 * `EFSRouter._parseContractFromWeb3URI` expects (`web3://0x<40-hex>`, address
 * only; chainId is NOT encoded in the URI — the router reads it on its own chain).
 *
 * ## v1 scope — single chunk only
 *
 * SSTORE2 chunks are bounded by the EIP-170 contract-code limit (~24 KB). The
 * default auto-cap is {@link DEFAULT_ONCHAIN_AUTO_LIMIT} (16 KB) so a default
 * on-chain write is always one chunk. An override (`{ storage: 'onchain' }`) can
 * exceed the cap, but if the payload is too big for ONE chunk we throw
 * {@link MultiChunkUnsupported} rather than half-implementing chunking — the chunk
 * manager wraps `address[]`, so multi-chunk is a clean later slice (deploy N
 * chunks, pass all N addresses), not a redesign.
 */

import { type Address, type Hex, toHex } from 'viem'
import { EfsError, classifyError, isDefiniteSendRefusal } from '../errors.js'
import { EFS_BYTES_STORE_BYTECODE } from './onchain-bytecode.js'

/**
 * Default cap (bytes) on a no-mirrors auto on-chain write. 16 KiB keeps the
 * payload to a SINGLE SSTORE2 chunk (chunks are bounded by the ~24 KB EIP-170
 * code limit), so v1 is single-chunk only. Above this with no mirrors → a typed
 * {@link PayloadTooLarge}. Resettable per client via the `write.onchainAutoLimit`
 * config; bypassable per call via `{ storage: 'onchain' }` (still single-chunk).
 */
export const DEFAULT_ONCHAIN_AUTO_LIMIT = 16 * 1024

/**
 * Hard ceiling (bytes) on a SINGLE SSTORE2 chunk's payload. The deployed runtime
 * is `0x00 || bytes`, and a contract's runtime code is bounded by EIP-170's
 * 24576-byte limit — so one chunk holds at most `24576 - 1` content bytes. A
 * payload over this (only reachable via the `storage:'onchain'` cap bypass) throws
 * {@link MultiChunkUnsupported}. Conservative by one byte for the STOP prefix.
 */
export const MAX_SINGLE_CHUNK_BYTES = 24576 - 1

/**
 * The bytes exceed the no-mirrors auto on-chain cap. The default save inlines
 * small content on-chain; larger content needs an explicit decision from the dev
 * (supply `mirrors`, or opt into on-chain with `{ storage: 'onchain' }`).
 */
export class PayloadTooLarge extends EfsError {
  override name = 'PayloadTooLarge'
  readonly bytes: number
  readonly limit: number
  constructor(bytes: number, limit: number) {
    super(
      `EFS write: content is ${bytes} bytes, over the ${limit}-byte on-chain auto-store cap. Pass \`mirrors: ["ipfs://…"]\` (or another off-chain URI) to host the bytes yourself, or \`{ storage: "onchain" }\` to force on-chain storage (single-chunk only, ~24 KB max).`,
      { code: 'PayloadTooLarge' },
    )
    this.bytes = bytes
    this.limit = limit
  }
}

/**
 * The bytes exceed what a single SSTORE2 chunk can hold (~24 KB). v1 on-chain
 * storage is single-chunk only; multi-chunk (deploy N chunks under one manager)
 * is a later slice. Reachable only via the `{ storage: 'onchain' }` cap bypass.
 */
export class MultiChunkUnsupported extends EfsError {
  override name = 'MultiChunkUnsupported'
  readonly bytes: number
  readonly maxBytes: number
  constructor(bytes: number, maxBytes: number) {
    super(
      `EFS write: content is ${bytes} bytes, over the ${maxBytes}-byte single-chunk on-chain limit. Multi-chunk on-chain storage is not yet supported — pass \`mirrors: ["ipfs://…"]\` to host the bytes off-chain instead.`,
      { code: 'MultiChunkUnsupported' },
    )
    this.bytes = bytes
    this.maxBytes = maxBytes
  }
}

/**
 * The minimal viem wallet surface on-chain storage needs: deploy a contract
 * (the chunk manager) and send a raw deploy transaction (the SSTORE2 chunk's
 * init-code stub — not a Solidity contract, so `deployContract` doesn't fit it).
 * Structurally satisfied by a viem `WalletClient`. Kept narrow so the module is
 * trivially mockable in unit tests, mirroring {@link SubmitWalletClient}.
 */
export interface OnchainWalletClient {
  /** Deploy the chunk-manager contract; returns its tx hash. The constructor takes
   * the chunk addresses AND the store's reported MIME (ERC-5219 `contentType_`). */
  deployContract(args: {
    abi: typeof EFS_BYTES_STORE_ABI
    bytecode: Hex
    args: readonly [readonly Address[], string]
    account?: unknown
    chain?: unknown
  }): Promise<Hex>
  /** Send the SSTORE2 chunk's init-code deploy (no `to`); returns its tx hash. */
  sendTransaction(args: {
    data: Hex
    account?: unknown
    chain?: unknown
    to?: undefined
  }): Promise<Hex>
}

/** The minimal viem public surface: wait for a receipt (we read `contractAddress`). */
export interface OnchainPublicClient {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ contractAddress?: Address | null }>
}

/** The deploy/wait context for {@link storeOnchain}. */
export interface OnchainStoreContext {
  readonly walletClient: OnchainWalletClient
  readonly publicClient: OnchainPublicClient
  /** Forwarded to viem's deploy/send when the wallet client isn't account-bound. */
  readonly account?: unknown
  /** Forwarded to viem's deploy/send when the wallet client isn't chain-bound. */
  readonly chain?: unknown
  /** The MIME the deployed store reports on its ERC-5219 `request()` path (the store's
   *  `contentType_` constructor arg). Empty/omitted ⇒ the store serves
   *  `application/octet-stream`. This is the SAME value the write path binds as the
   *  lens-scoped `contentType` PROPERTY, so a bare `web3://<store>` URL self-describes
   *  consistently with the EFS metadata. The SDK reader IGNORES it (it trusts the
   *  PROPERTY); it exists for generic EIP-4804/5219 clients. */
  readonly contentType?: string
  /** Optional cancellation signal, checked before each of the two irreversible
   *  deploys (chunk, then manager) — never mid-flight (a sent tx can't be unsent). */
  readonly signal?: AbortSignal
  /** Optional live-chain assertion, re-run BEFORE each of the two deploys (chunk, then
   *  manager). The store is two separate wallet confirmations; an injected wallet can
   *  switch networks between them, so the manager deploy must not broadcast to the new
   *  chain while the chunk's receipt was awaited on the deployment chain (a wasted chunk +
   *  orphaned storage step). Wired to the same wallet-vs-deployment guard as the EAS layers
   *  (fails closed with `WrongChain`). Omitted ⇒ no check (unit tests). */
  readonly assertChain?: () => Promise<void>
}

/**
 * The EFSBytesStore constructor ABI — all `walletClient.deployContract` needs to
 * ABI-encode the `address[]` chunk-list arg. The reader methods (`chunkCount` /
 * `chunkAddress`, the `IChunkedSSTORE2` interface `EFSRouter` probes) live in the
 * read-path ABI (`chain/abi/chunkStore.ts`), not here: the WRITE path only needs the
 * constructor. Keeping this ABI to the constructor keeps the deploy encoding minimal.
 */
export const EFS_BYTES_STORE_ABI = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'chunks', type: 'address[]' },
      // ERC-5219 store MIME (empty ⇒ application/octet-stream). The router reads bytes
      // by interface; this arg only affects the store's own `request()`/`contentType()`.
      { name: 'contentType_', type: 'string' },
    ],
  },
] as const

/**
 * Build the SSTORE2 chunk init code for `bytes`: `runtime = 0x00 || bytes`, wrapped
 * in the 12-byte CODECOPY/RETURN stub. Ported from `simulate-transports.ts`
 * `deploySSTORE2Chunk` — the router's web3:// read skips the first runtime byte, so
 * the STOP-byte prefix is mandatory. Pure; does not touch the chain.
 *
 * @throws {MultiChunkUnsupported} if `bytes` can't fit in one chunk's runtime.
 */
export function buildSstore2InitCode(bytes: Uint8Array): Hex {
  if (bytes.byteLength > MAX_SINGLE_CHUNK_BYTES) {
    throw new MultiChunkUnsupported(bytes.byteLength, MAX_SINGLE_CHUNK_BYTES)
  }
  // runtime = 0x00 (SSTORE2 STOP-byte) || content.
  const runtimeLen = bytes.byteLength + 1
  // PUSH2 expects a 2-byte big-endian length. EIP-170 keeps runtimeLen < 0x10000,
  // so two bytes always suffice (guarded by MAX_SINGLE_CHUNK_BYTES above).
  const lenHex = runtimeLen.toString(16).padStart(4, '0')
  // 61 <len> 80 600c 6000 39 6000 f3  ||  00 <content>
  const prefix = `0x61${lenHex}80600c6000396000f300`
  return `${prefix}${bytesToHex(bytes)}` as Hex
}

/** Lowercase hex (no `0x`) of a byte array — concatenated after the init prefix. */
function bytesToHex(bytes: Uint8Array): string {
  return toHex(bytes).slice(2)
}

/**
 * Store `bytes` on-chain as a single SSTORE2 chunk + chunk manager and return the
 * canonical `web3://<chunkManager>` MIRROR URI. Two transactions: the chunk deploy,
 * then the manager (`EFSBytesStore`) deploy wrapping the chunk address + the store's
 * reported MIME (`ctx.contentType`). The store is a standards-compliant ERC-5219
 * resource, so the resulting `web3://<store>` resolves both via the EFS router
 * (extcodecopy chunk path) AND in any generic EIP-4804/5219 client.
 *
 * Every wallet/RPC call (the two deploys + each receipt wait) runs through the SAME
 * {@link classifyError} funnel the submitter uses, so a wallet rejection / RPC failure
 * on the default `fs.write(path, bytes)` quickstart path surfaces as the documented
 * typed tree (`UserRejected` / `RpcError` / …) instead of a raw viem/provider error.
 * The pre-send `signal.throwIfAborted()` checks stay OUTSIDE the funnel so an abort
 * still propagates as the caller's `AbortError`, not a generic wrapped `EfsError`.
 *
 * @throws {MultiChunkUnsupported} if `bytes` exceeds one chunk's capacity.
 * @throws {EfsError} a classified wallet/RPC failure (`UserRejected`/`RpcError`/…), or
 *   if a deploy receipt carries no `contractAddress` (a deploy that didn't create a
 *   contract — a wrong receipt or a non-deploy tx).
 * @throws {OnchainSendUnknown} the CHUNK deploy's send failed without a response —
 *   broadcast state unknown, no hash; it may still mine (never retry blind).
 */
export async function storeOnchain(
  bytes: Uint8Array,
  ctx: OnchainStoreContext,
): Promise<{
  web3Uri: string
  chunkManager: Address
  chunkAddress: Address
  /** The wallet transactions this store sent, in order (chunk deploy, then manager
   * deploy). Each is a wallet signature the caller's `signatureCount`/UI must account
   * for — they happen BEFORE any EAS attestation layer. v1 is single-chunk ⇒ length 2. */
  txHashes: readonly Hex[]
}> {
  const fwd = {
    ...(ctx.account !== undefined ? { account: ctx.account } : {}),
    ...(ctx.chain !== undefined ? { chain: ctx.chain } : {}),
  }

  // 1. Deploy the SSTORE2 chunk (raw init-code deploy; throws on multi-chunk).
  ctx.signal?.throwIfAborted()
  // Re-assert the live chain before the chunk deploy — the wallet may have switched
  // networks since the caller's fs.write preflight (parent reads happen in between).
  await ctx.assertChain?.()
  const initCode = buildSstore2InitCode(bytes)
  let chunkTx: Hex
  try {
    chunkTx = await classified(() => ctx.walletClient.sendTransaction({ data: initCode, ...fwd }))
  } catch (cause) {
    // Refusal-vs-transport split, same rule as the manager leg below and the
    // layered submitter (r3740994134): a refusal RESPONSE proves nothing was
    // broadcast — the classified error propagates and a retry is clean. A
    // code-less transport failure proves nothing: the chunk deploy may have
    // been accepted and still mine (billing gas) with no hash to reconcile
    // by — a blind fs.write retry would pay for a DUPLICATE chunk.
    if (isDefiniteSendRefusal(cause)) throw cause
    throw new OnchainSendUnknown('SSTORE2 chunk', cause)
  }
  const chunkAddress = await requireContractAddress(ctx, chunkTx, 'SSTORE2 chunk')

  // 2. Deploy the chunk manager wrapping the chunk address (single-element array).
  //    The chunk is now LANDED and IRREVERSIBLE — every failure from here to the
  //    manager broadcast (abort, chain drift, wallet rejection) must carry the
  //    landed chunk state: a raw error would invite a blind fs.write retry that
  //    pays for a DUPLICATE chunk while this one sits on-chain.
  let managerTx: Hex
  try {
    // Re-check the signal BETWEEN the two irreversible deploys — an abort after the
    // chunk landed must not still send the manager tx.
    ctx.signal?.throwIfAborted()
    // Re-assert the live chain BETWEEN the two deploys — the wallet prompt for the chunk
    // is the user's chance to switch networks; the manager must not land on the new chain
    // while the chunk's receipt was awaited on the deployment chain (orphaned storage).
    await ctx.assertChain?.()
  } catch (cause) {
    // PRE-send guard failures (abort / chain drift) are definitively
    // never-broadcast — the confident "wrap the existing chunk" recovery holds.
    throw new OnchainStoreIncomplete(chunkAddress, chunkTx, cause)
  }
  try {
    managerTx = await classified(() =>
      ctx.walletClient.deployContract({
        abi: EFS_BYTES_STORE_ABI,
        bytecode: EFS_BYTES_STORE_BYTECODE,
        // The store reports `ctx.contentType` on its ERC-5219 path (empty ⇒
        // application/octet-stream). viem ABI-encodes the 2-arg constructor.
        args: [[chunkAddress], ctx.contentType ?? ''],
        ...fwd,
      }),
    )
  } catch (cause) {
    // Refusal-vs-transport split, same rule as the layered submitter
    // (r3740967877): a classified refusal RESPONSE proves the manager deploy
    // was never broadcast; a code-less transport failure proves nothing — the
    // deploy may still mine, and an immediate re-wrap would pay for a
    // DUPLICATE manager. The flag switches the recovery guidance.
    throw new OnchainStoreIncomplete(chunkAddress, chunkTx, cause, undefined, {
      managerBroadcastUnknown: !isDefiniteSendRefusal(cause),
    })
  }
  let chunkManager: Address
  try {
    chunkManager = await requireContractAddress(ctx, managerTx, 'chunk manager')
  } catch (cause) {
    // The chunk is landed and paid for whatever happened to the manager —
    // whether its wait failed (OnchainDeployUnconfirmed underneath: the manager
    // may STILL mine) or it mined without a contract address (definite
    // failure). Either way the caller needs the chunk state to recover by
    // wrapping the EXISTING chunk, not a blind full retry.
    throw new OnchainStoreIncomplete(chunkAddress, chunkTx, cause, managerTx)
  }

  // web3://<chunkManager> — EFSRouter._parseContractFromWeb3URI parses the address
  // only (chainId is the router's own chain, never encoded in the URI). viem's
  // `deployContract` ABI-encodes the `address[]` constructor arg from the ABI, so
  // the on-chain encoding stays single-sourced through viem (not hand-rolled).
  return {
    web3Uri: `web3://${chunkManager}`,
    chunkManager,
    chunkAddress,
    txHashes: [chunkTx, managerTx],
  }
}

/** Run a wallet/RPC call through the {@link classifyError} funnel so a raw viem/provider
 * failure surfaces as the SDK's typed error tree (`UserRejected`/`RpcError`/…). Idempotent
 * for an already-typed `EfsError` (it passes through unchanged). */
async function classified<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    throw classifyError(cause)
  }
}

/** Wait for a deploy receipt and return its created contract address, or throw. */
async function requireContractAddress(
  ctx: OnchainStoreContext,
  hash: Hex,
  what: string,
): Promise<Address> {
  let receipt: { contractAddress?: Address | null }
  try {
    // The provider can drift AFTER the deploy tx is broadcast and BEFORE this wait; waiting
    // on the wrong chain would surface a deploy that mined on the deployment chain as "no
    // contract address", aborting the default no-mirror write even though the chunk/manager
    // landed. Re-assert the live chain before waiting so a drift fails closed.
    await ctx.assertChain?.()
    receipt = await classified(() => ctx.publicClient.waitForTransactionReceipt({ hash }))
  } catch (cause) {
    // The deploy tx IS broadcast — a wait failure (timeout / RPC loss / chain
    // drift) is an UNKNOWN outcome, not a definite failure. Losing the hash
    // here would invite a blind retry that pays for a DUPLICATE chunk/manager
    // deploy while the first still mines — preserve the in-flight state the
    // way the layered submitter does for sent-but-unconfirmed layers.
    throw new OnchainDeployUnconfirmed(hash, what, cause)
  }
  const addr = receipt.contractAddress
  if (addr === undefined || addr === null) {
    throw new EfsError(
      `EFS write: on-chain ${what} deploy (tx ${hash}) produced no contract address. The transaction did not create a contract.`,
      { code: 'EfsError' },
    )
  }
  return addr
}

/** The COMPLETED on-chain storage a write performed before its EAS layers —
 * both deploys landed and are irreversible. Attached to attestation-phase
 * partial-write errors so a retry can REUSE this storage (pass its `web3Uri`
 * as an explicit mirror) instead of paying for duplicate deploys. */
export type CompletedOnchainStorage = {
  readonly web3Uri: string
  readonly chunkManager: Address
  readonly chunkAddress: Address
  readonly txHashes: readonly Hex[]
}

/** The SSTORE2 chunk LANDED (irreversibly, receipt confirmed) but the write
 * stopped before the manager tx was broadcast — an abort, a chain drift, or a
 * wallet rejection on the second leg. Carries the landed chunk state so the
 * caller (or a future resume) can wrap the EXISTING chunk in a manager instead
 * of a blind `fs.write` retry paying for a duplicate chunk deploy. */
export class OnchainStoreIncomplete extends EfsError {
  override name = 'OnchainStoreIncomplete'
  /** The landed (irreversible) SSTORE2 chunk contract. */
  readonly chunkAddress: Address
  /** The mined chunk deploy transaction. */
  readonly chunkTx: Hex
  /** The manager deploy tx, when the failure happened AT/AFTER its broadcast
   * (its receipt failed or lacked a contract address — see `cause`; an
   * `OnchainDeployUnconfirmed` cause means the manager may STILL mine). Absent
   * when the write stopped before the manager was ever sent — or when its send
   * failed WITHOUT a response (see `managerBroadcastUnknown`). */
  readonly managerTx?: Hex
  /** `true` when the manager SEND failed without a response (code-less
   * transport loss) — whether it was broadcast is UNKNOWN and it may STILL
   * MINE even though no hash is available. `false` when the failure was a
   * refusal RESPONSE or happened before the send, which proves the manager was
   * never broadcast (the confident re-wrap recovery is then safe). */
  readonly managerBroadcastUnknown: boolean
  constructor(
    chunkAddress: Address,
    chunkTx: Hex,
    cause: unknown,
    managerTx?: Hex,
    opts?: { managerBroadcastUnknown?: boolean },
  ) {
    const unknownSend = opts?.managerBroadcastUnknown === true
    super(
      managerTx !== undefined
        ? `EFS write: the SSTORE2 chunk landed at ${chunkAddress} (tx ${chunkTx}), but the chunk-manager leg (tx ${managerTx}) failed — see cause for whether it may still mine. The chunk is on-chain and paid for — a blind fs.write retry deploys a DUPLICATE; recovery should check the manager tx's fate and wrap the existing chunk if it did not land.`
        : unknownSend
          ? `EFS write: the SSTORE2 chunk landed at ${chunkAddress} (tx ${chunkTx}), and the chunk-manager deploy's send failed WITHOUT a response — whether it was broadcast is UNKNOWN and it may STILL MINE (no tx hash is available). Do NOT immediately wrap the chunk again (a broadcast manager would be duplicated and paid twice): check the signing account's pending transactions/nonce first, and wrap the existing chunk only once no manager lands.`
          : `EFS write: the SSTORE2 chunk landed at ${chunkAddress} (tx ${chunkTx}), but the write stopped before the chunk-manager deploy. The chunk is on-chain and paid for — a blind fs.write retry deploys a DUPLICATE; recovery should wrap the existing chunk in a manager instead.`,
      { code: 'PartialBatchFailure', cause },
    )
    this.chunkAddress = chunkAddress
    this.chunkTx = chunkTx
    this.managerBroadcastUnknown = unknownSend
    if (managerTx !== undefined) this.managerTx = managerTx
  }
}

/** A storage deploy's SEND failed WITHOUT a response — the transport dropped
 * after the request may already have reached the node, so whether the deploy
 * was broadcast is UNKNOWN: it may still mine and bill gas, and there is NO
 * hash to reconcile by. Distinct from {@link OnchainDeployUnconfirmed} (a hash
 * exists, only the receipt is unknown) and from a classified refusal (a
 * RESPONSE proves nothing was sent — that propagates as the classified error).
 * Check the signing account's pending transactions/nonce before retrying — a
 * blind fs.write retry can pay for a DUPLICATE deploy. */
export class OnchainSendUnknown extends EfsError {
  override name = 'OnchainSendUnknown'
  /** Which deploy this was (`SSTORE2 chunk` today; the manager leg carries its
   * uncertainty on `OnchainStoreIncomplete.managerBroadcastUnknown` instead,
   * because the landed chunk state must ride along there). */
  readonly what: string
  constructor(what: string, cause: unknown) {
    super(
      `EFS write: the on-chain ${what} deploy's send failed WITHOUT a response — whether it was broadcast is UNKNOWN and it may STILL MINE and bill gas (no tx hash is available). Check the signing account's pending transactions/nonce before retrying: a blind fs.write retry can pay for a DUPLICATE ${what}.`,
      { code: 'PartialBatchFailure', cause },
    )
    this.what = what
  }
}

/** A storage deploy tx was BROADCAST but its receipt could not be confirmed
 * (timeout / RPC loss / provider chain-drift during the wait) — the outcome is
 * UNKNOWN, not failed: the deploy may still mine and bill gas. Carries the
 * in-flight `txHash` so recovery can check its fate instead of blindly
 * retrying `fs.write` into a duplicate chunk/manager deploy. */
export class OnchainDeployUnconfirmed extends EfsError {
  override name = 'OnchainDeployUnconfirmed'
  /** The broadcast deploy transaction whose receipt is unconfirmed. */
  readonly txHash: Hex
  /** Which deploy this was (`chunk N` / `manager`). */
  readonly what: string
  constructor(txHash: Hex, what: string, cause: unknown) {
    super(
      `EFS write: the on-chain ${what} deploy (tx ${txHash}) was broadcast but its receipt could not be confirmed — the transaction may STILL MINE and bill gas. Check the tx's fate before retrying: a blind fs.write retry deploys a duplicate ${what}.`,
      { code: 'PartialBatchFailure', cause },
    )
    this.txHash = txHash
    this.what = what
  }
}
