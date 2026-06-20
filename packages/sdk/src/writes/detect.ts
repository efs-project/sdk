/**
 * **Account detection** (sdk-wallet-architecture §Detection) — derive the internal
 * {@link AccountProfile} that the pure selector branches on. Capability-shaped, not
 * wallet-branded: `getCode` classifies the account `kind`, the EIP-5792
 * `getCapabilities` blob (when the wallet supports it) is unwrapped into the
 * normalized `batchExecution`/`sponsorable`, and the raw blob is quarantined in
 * `raw`.
 *
 * Pure (the only I/O is the two reads on the passed client) + cached per
 * `(address, chainId)`. Tolerant: a wallet that does not implement
 * `getCapabilities` yields `batchExecution: undefined` rather than throwing.
 *
 * ## Latency: NOT on the Tier-1 hot path
 *
 * Detection is deliberately OFF the write hot path. Tier-1 is the only live
 * strategy and never needs a profile to run, so `efs.fs.write` must not start doing
 * a `getCapabilities` round-trip on every write. `detectAccount` is called lazily —
 * only by `efs.account.capabilities()` — and its result is cached, so repeated
 * reads are free. The deferred AA work will call it before selection, but gated by
 * an `account` that can actually use an in-account routine; it does not regress the
 * current any-wallet write latency.
 *
 * Adapters (the design's authoritative-over-`getCode` layer) are not implemented
 * yet, so `canRunInAccountRoutine` is always `false` here — no in-account adapter
 * exists to flip it. That hook lands with the AA slice.
 */

import type { Address, Hex } from 'viem'
import type { AccountCapabilities, AccountProfile } from '../types.js'

/** The EIP-7702 delegation-designator prefix: code is `0xef0100‖impl` for a
 * delegated EOA (EIP-7702). */
const EIP7702_PREFIX = '0xef0100'

/**
 * The minimal client surface detection needs: read an address's bytecode, and
 * (optionally) the wallet's EIP-5792 capabilities. Narrow + structural — a viem
 * `PublicClient` satisfies `getCode`; a viem `WalletClient` satisfies
 * `getCapabilities`. `getCapabilities` is optional so a wallet without it (most
 * EOAs) is tolerated.
 */
export interface DetectClient {
  /** `eth_getCode` — `0x` for a plain EOA, `0xef0100‖impl` for a 7702-delegated
   * EOA, contract bytecode for a smart account. viem returns `undefined` for `0x`. */
  getCode(args: { address: Address }): Promise<Hex | undefined>
  /** EIP-5792 `wallet_getCapabilities`. Optional — absent on wallets that don't
   * implement it. The nested shape is `{ [chainId]: { atomic?, paymasterService? } }`
   * (hex or numeric chain keys). */
  getCapabilities?: (args?: { account?: Address; chainId?: number }) => Promise<unknown>
}

/** Classify an account `kind` from its bytecode (`getCode`). `0x`/empty → `eoa`
 * (necessary-not-sufficient — a counterfactual 4337 account is also `0x`, which an
 * adapter would later correct); `0xef0100‖impl` → `eoa-7702-delegated`; any other
 * code → `smart-account`. Pure. */
export function kindFromCode(code: Hex | undefined): AccountProfile['kind'] {
  if (code === undefined || code === '0x' || code.length <= 2) return 'eoa'
  if (code.toLowerCase().startsWith(EIP7702_PREFIX)) return 'eoa-7702-delegated'
  return 'smart-account'
}

/** One chain's slice of the EIP-5792 `getCapabilities` blob, as a viem-shaped
 * record (both members optional, statuses are strings). */
type RawChainCaps = {
  atomic?: { status?: unknown }
  paymasterService?: { supported?: unknown }
}

/**
 * Unwrap the nested EIP-5792 `getCapabilities` shape for one chain into the
 * normalized `batchExecution`/`sponsorable`. viem keys the blob by chain id (hex
 * `'0xaa36a7'` or numeric); we look up both forms. A blob with no entry for the
 * chain (or a wallet that returned nothing) yields `batchExecution: undefined` and
 * `sponsorable: false`. Pure.
 */
export function unwrapCapabilities(
  raw: unknown,
  chainId: number,
): { batchExecution?: NonNullable<AccountProfile['batchExecution']>; sponsorable: boolean } {
  const chainCaps = chainCapsFor(raw, chainId)
  if (chainCaps === undefined) return { sponsorable: false }

  const atomicStatus = chainCaps.atomic?.status
  const sponsorable = chainCaps.paymasterService?.supported === true

  if (typeof atomicStatus !== 'string') return { sponsorable }
  return { batchExecution: { atomic: atomicStatus }, sponsorable }
}

/** Locate the per-chain caps record under either a hex (`0x…`) or numeric chain
 * key. Defensive: a non-object blob (or one without the chain) returns `undefined`. */
function chainCapsFor(raw: unknown, chainId: number): RawChainCaps | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const map = raw as Record<string, RawChainCaps>
  const hexKey = `0x${chainId.toString(16)}`
  return map[hexKey] ?? map[String(chainId)] ?? undefined
}

/** Cache key — the SIGNING account + chain (the profile must derive from the
 * account that will actually sign; attester-invariant correctness). */
const cacheKey = (address: Address, chainId: number): string =>
  `${address.toLowerCase()}@${chainId}`

const profileCache = new Map<string, Promise<AccountProfile>>()

/** Drop a cached profile (e.g. on `accountsChanged`/`chainChanged`). Exposed for
 * the AA slice's connector-switch invalidation; today nothing wires it, but the
 * cache is keyed so a stale profile is never reused across an account change. */
export function invalidateAccountProfile(address: Address, chainId: number): void {
  profileCache.delete(cacheKey(address, chainId))
}

/**
 * Detect the {@link AccountProfile} for `address` on `chainId`. Reads `getCode`
 * (→ `kind`) and, when the client supports it, `getCapabilities`
 * (→ `batchExecution`/`sponsorable`). `canRunInAccountRoutine` is `false` until
 * in-account adapters land. Cached per `(address, chainId)`.
 *
 * Tolerant of a wallet without `getCapabilities` (→ `batchExecution: undefined`),
 * and of a `getCapabilities` that throws (the EOA case — treated as no caps).
 */
export function detectAccount(
  client: DetectClient,
  address: Address,
  chainId: number,
): Promise<AccountProfile> {
  const key = cacheKey(address, chainId)
  const cached = profileCache.get(key)
  if (cached !== undefined) return cached

  const pending = computeProfile(client, address, chainId)
  profileCache.set(key, pending)
  // On failure, evict so a later call retries rather than caching a rejection.
  pending.catch(() => profileCache.delete(key))
  return pending
}

async function computeProfile(
  client: DetectClient,
  address: Address,
  chainId: number,
): Promise<AccountProfile> {
  const code = await client.getCode({ address })
  const kind = kindFromCode(code)

  let raw: unknown
  if (client.getCapabilities !== undefined) {
    try {
      raw = await client.getCapabilities({ account: address, chainId })
    } catch {
      // A wallet that advertises the method but rejects (a plain EOA, an
      // unsupported chain) is treated as having no capabilities — never fatal.
      raw = undefined
    }
  }

  const { batchExecution, sponsorable } = unwrapCapabilities(raw, chainId)

  return {
    address,
    kind,
    ...(batchExecution !== undefined ? { batchExecution } : {}),
    sponsorable,
    // No in-account adapter exists yet — the AA slice flips this.
    canRunInAccountRoutine: false,
    ...(raw !== undefined ? { raw } : {}),
  }
}

/**
 * Project the internal {@link AccountProfile} to the public curated
 * {@link AccountCapabilities} — what `efs.account.capabilities()` returns. No
 * internals leak: never `atomic:'ready'`, never an adapter id; just the dev's
 * actual questions. `canOneSig` mirrors `canRunInAccountRoutine` (only an
 * in-account routine collapses a single dependent file to one signature; 5792
 * atomic does not apply to a single file's dependent DAG). Pure.
 */
export function toCapabilities(profile: AccountProfile): AccountCapabilities {
  return {
    kind: profile.kind,
    canOneSig: profile.canRunInAccountRoutine,
    gasless: profile.sponsorable,
    sponsored: profile.sponsorable,
  }
}
