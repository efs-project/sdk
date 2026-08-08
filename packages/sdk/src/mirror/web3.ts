/**
 * `web3://` read transport — read back the bytes of an on-chain (SSTORE2) stored
 * file, matching `EFSRouter.sol`'s `web3://` read branch EXACTLY (EFSRouter.sol:326-403).
 *
 * The write path (`writes/onchain.ts`) deploys, per file, one or more SSTORE2 chunks
 * plus an `EFSBytesStore` chunk-manager, then publishes a `web3://<chunkManager>`
 * MIRROR. This module is the inverse: given that `web3://0x<40hex>` URI it returns
 * the original file bytes.
 *
 * ## How it matches the router (EFSRouter.sol)
 *
 *   1. **Parse the target** — `_parseContractFromWeb3URI` (EFSRouter.sol:527) reads a
 *      `web3://0x<40-hex>` (or `0X`) URI to an address. The chainId is NOT encoded
 *      in the URI — the router reads on its own chain — so the SDK uses the read
 *      `publicClient`'s chain. We parse the same shape: `web3://` prefix, optional
 *      `0x`/`0X`, then exactly 40 hex chars → the chunk-manager address.
 *   2. **Probe for chunking** — the router `staticcall`s `chunkCount()`
 *      (EFSRouter.sol:345). The `EFSBytesStore` manager implements
 *      `IChunkedSSTORE2`, so this succeeds and yields the chunk count. (The router
 *      tolerates a non-chunked SSTORE2 contract by reading the target directly; the
 *      SDK only ever writes via the chunk manager, so we always go through it.)
 *   3. **Read each chunk** — for `i in 0..chunkCount`, `chunkAddress(i)`
 *      (EFSRouter.sol:359) → the SSTORE2 code contract; then `getCode(addr)`
 *      (the router's `extcodecopy`, EFSRouter.sol:400) → its runtime bytecode.
 *   4. **Strip the STOP byte + concat** — the SSTORE2 runtime is `0x00 || content`
 *      (the write path's `buildSstore2InitCode`); the router skips the first byte
 *      (EFSRouter.sol:391-400, `extcodecopy(…, 1, size-1)`). We drop the leading
 *      `0x00` of every chunk and concatenate → the file bytes.
 *
 * The returned bytes are then contentHash-verified by the engine exactly like any
 * off-chain mirror (the on-chain store is a *locator*, never trusted as the hash).
 */

import {
  AbiDecodingZeroDataError,
  type Address,
  BaseError,
  ContractFunctionZeroDataError,
  type Hex,
  getAddress,
  hexToBytes,
} from 'viem'
import { chunkedSstore2Abi } from '../chain/abi/chunkStore.js'

/** The minimal viem public surface the `web3://` read needs: a typed `readContract`
 * (for `chunkCount`/`chunkAddress`) and `getCode` (the SSTORE2 chunk bytecode).
 * Structurally satisfied by a viem `PublicClient`; kept narrow so it is trivially
 * mockable in unit tests. */
export interface Web3ReadClient {
  readContract(args: {
    address: Address
    abi: typeof chunkedSstore2Abi
    functionName: 'chunkCount' | 'chunkAddress'
    args?: readonly unknown[]
  }): Promise<unknown>
  getCode(args: { address: Address }): Promise<Hex | undefined>
}

/** Thrown when a `web3://` URI cannot be parsed or read back. The fetch engine
 * records it as a failed attempt so a later mirror can still win. */
export class Web3ReadError extends Error {
  override readonly name = 'Web3ReadError'
  constructor(detail: string) {
    super(`web3:// read failed: ${detail}`)
  }
}

/** Hard cap on chunks scanned per file — defends against a hostile/looping manager
 * claiming an absurd `chunkCount`. Generous: a chunk holds ~24 KB, so 4096 chunks
 * is ~96 MB, well past the engine's default 50 MB size cap (which still applies). */
const MAX_CHUNKS = 4096

/**
 * Parse a `web3://0x<40-hex>` URI to the chunk-manager address. Mirrors
 * `EFSRouter._parseContractFromWeb3URI` (EFSRouter.sol:527): `web3://` prefix, an
 * optional `0x`/`0X`, then exactly 40 hex chars. The chainId is NOT part of the URI.
 * Trailing segments (e.g. a `/path` or `?chunk=` the router would parse) are ignored
 * — the SDK forms bare `web3://<addr>` URIs, but we tolerate a suffix by reading the
 * 40 hex chars right after the prefix, exactly as the router does.
 *
 * @throws {Web3ReadError} on a malformed URI (wrong prefix, too short, non-hex).
 */
export function parseWeb3Uri(uri: string): Address {
  const lower = uri.toLowerCase()
  if (!lower.startsWith('web3://')) {
    throw new Web3ReadError(`not a web3:// URI: ${uri.slice(0, 16)}`)
  }
  let rest = uri.slice('web3://'.length)
  // Optional 0x / 0X prefix (the router accepts both).
  if (rest.length >= 2 && rest[0] === '0' && (rest[1] === 'x' || rest[1] === 'X')) {
    rest = rest.slice(2)
  }
  const hex = rest.slice(0, 40)
  if (hex.length < 40 || !/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Web3ReadError(`malformed address in ${uri.slice(0, 64)}`)
  }
  // Lowercase BEFORE `getAddress`: the router parses the address numerically /
  // case-insensitively, so a router-valid mirror may carry arbitrary mixed-case hex with
  // NO valid EIP-55 checksum. Passing that verbatim would make `getAddress` throw
  // `InvalidAddress` and fail an otherwise-valid read (esp. when it's the only mirror).
  // All-lowercase is always accepted; `getAddress` returns the canonical checksummed form.
  return getAddress(`0x${hex.toLowerCase()}`)
}

/**
 * Read the bytes of a `web3://`-stored file via the chunk manager. Reads
 * `chunkCount()`, then for each chunk `chunkAddress(i)` + `getCode(addr)`, strips the
 * leading SSTORE2 `0x00` STOP byte, and concatenates. Matches the router's read.
 *
 * @throws {Web3ReadError} on a malformed URI, an unreadable chunk count/address, or a
 *   chunk contract with no code (the router returns HTTP 500 in those cases).
 * @throws {RangeError} on a non-finite/non-positive `maxBytes` — this is a PUBLIC
 *   entry point (every downstream cap check is a `>`, so NaN never rejects and
 *   Infinity disables the ceiling across up to {@link MAX_CHUNKS} chunk reads);
 *   same rule as the other exported transport helpers.
 * @throws {DOMException} (`AbortError`) when `opts.signal` aborts — checked
 *   between chunk RPCs, so a caller's cancellation (or the fetch engine's
 *   per-attempt timeout) stops a long chunk walk instead of blocking failover.
 */
export async function readWeb3Bytes(
  uri: string,
  client: Web3ReadClient,
  opts?: { maxBytes?: number; signal?: AbortSignal } | number,
): Promise<Uint8Array> {
  // Back-compat shim for the prior positional `maxBytes` (pre-1.0 courtesy —
  // the object form is canonical).
  const o = typeof opts === 'number' ? { maxBytes: opts } : (opts ?? {})
  const { maxBytes, signal } = o
  if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes <= 0)) {
    throw new RangeError(
      `readWeb3Bytes: \`maxBytes\` must be a finite positive number (got ${maxBytes}). Omit it for an uncapped read (the fetch engine always passes its cap).`,
    )
  }
  signal?.throwIfAborted()
  const manager = parseWeb3Uri(uri)

  // chunkCount() — the router probes this to detect EIP-7617 chunking (it
  // staticcalls and treats a >=32-byte return as a uint256 count). The SDK always
  // writes via the chunk manager, so this is always present on a SDK-written file.
  let count: bigint
  try {
    count = (await client.readContract({
      address: manager,
      abi: chunkedSstore2Abi,
      functionName: 'chunkCount',
    })) as bigint
  } catch (err) {
    // Fall back to a RAW single-SSTORE2 read ONLY for the expected "not a chunk manager"
    // signal: the target returned 0x for `chunkCount()` (a raw SSTORE2 contract has no
    // function dispatcher, so the call STOPs and returns empty data). The canonical router
    // treats that short return as "not chunked" and reads the TARGET's own bytecode via
    // extcodecopy from offset 1 (EFSRouter.sol web3:// branch) — mirror it (router parity,
    // ADR-0013). A transport/RPC failure (timeout, connection error, rate-limit) on a REAL
    // chunk manager must NOT be mistaken for a raw store: returning the manager's own
    // bytecode would surface garbage and pre-empt later mirrors. Propagate it as a failed
    // attempt (Web3ReadError) so the fetch engine moves on to the next mirror.
    const returnedNoData =
      err instanceof BaseError &&
      err.walk(
        (e) => e instanceof ContractFunctionZeroDataError || e instanceof AbiDecodingZeroDataError,
      ) !== null
    if (returnedNoData) return readRawSstore2(manager, client, maxBytes)

    throw new Web3ReadError(`chunkCount() unreadable on ${manager}: ${errMsg(err)}`)
  }
  if (count <= 0n) throw new Web3ReadError(`chunk manager ${manager} reports zero chunks`)
  if (count > BigInt(MAX_CHUNKS)) {
    throw new Web3ReadError(`chunk count ${count} exceeds the ${MAX_CHUNKS}-chunk scan cap`)
  }

  const parts: Uint8Array[] = []
  let total = 0
  for (let i = 0n; i < count; i += 1n) {
    // Cancellation point: one check per chunk bounds a stalled/hostile walk to a
    // single in-flight RPC after the caller (or the per-attempt timer) aborts.
    signal?.throwIfAborted()
    let chunkAddr: Address
    try {
      chunkAddr = (await client.readContract({
        address: manager,
        abi: chunkedSstore2Abi,
        functionName: 'chunkAddress',
        args: [i],
      })) as Address
    } catch (err) {
      throw new Web3ReadError(`chunkAddress(${i}) unreadable on ${manager}: ${errMsg(err)}`)
    }

    const code = await client.getCode({ address: chunkAddr })
    // The router returns HTTP 500 ("Storage contract has no code") when extcodesize
    // is 0; an SSTORE2 runtime of just the STOP byte (size 1) carries no content.
    if (code === undefined || code === '0x' || code.length <= 2) {
      throw new Web3ReadError(`chunk ${i} contract ${chunkAddr} has no code`)
    }
    const bytes = hexToBytes(code)
    // SSTORE2 convention: runtime is `0x00 || content`; the router skips the first
    // byte (extcodecopy from offset 1). Drop it. A 1-byte (STOP-only) runtime → empty.
    const content = bytes.subarray(1)
    parts.push(content)
    total += content.byteLength
    // Stop AS SOON AS the running total exceeds the cap — don't read/allocate the
    // remaining chunks (an attacker-controlled mirror could otherwise force up to
    // MAX_CHUNKS of RPC + ~96 MB of allocation before the post-hoc cap check).
    if (maxBytes !== undefined && total > maxBytes) {
      throw new Web3ReadError(
        `on-chain payload exceeds cap (${maxBytes} bytes) after ${(i + 1n).toString()} chunk(s)`,
      )
    }
  }

  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Read a `web3://` target as a single RAW SSTORE2 contract — the router's fallback when
 * `chunkCount()` is absent (the target is not a chunk manager). Reads the target's runtime
 * code and strips the leading SSTORE2 `0x00` STOP byte (extcodecopy from offset 1),
 * mirroring `EFSRouter.sol`'s web3:// branch exactly. A no-code target throws
 * {@link Web3ReadError} (the router's HTTP 500); a STOP-only (1-byte) runtime is empty
 * content (the router returns a 200 empty body).
 */
async function readRawSstore2(
  addr: Address,
  client: Web3ReadClient,
  maxBytes?: number,
): Promise<Uint8Array> {
  const code = await client.getCode({ address: addr })
  if (code === undefined || code === '0x' || code.length <= 2) {
    throw new Web3ReadError(`web3:// target ${addr} has no code`)
  }
  const content = hexToBytes(code).subarray(1)
  if (maxBytes !== undefined && content.byteLength > maxBytes) {
    throw new Web3ReadError(`on-chain payload exceeds cap (${maxBytes} bytes)`)
  }
  return content
}
