/**
 * Typed builders for EAS `attest` / `multiAttest` calls.
 *
 * These produce the argument tuples for viem's `writeContract` (or
 * `simulateContract`) — they do NOT execute anything. The SDK stays a pure
 * request builder here; the caller owns the `walletClient` and gas/value
 * policy. Spread the returned object into `writeContract`:
 *
 *   await walletClient.writeContract({ ...buildAttest(req, eas), account, chain })
 *
 * Struct shapes mirror `IEAS.sol` (`AttestationRequestData` lines 10-17,
 * `AttestationRequest` lines 20-23, `MultiAttestationRequest` lines 35-38).
 */

import type { Address, Hex } from 'viem'
import { easAbi } from './abi.js'

/**
 * `AttestationRequestData` (IEAS.sol:10-17).
 *
 * `value` is optional in this builder and defaults to `0n` — it's the explicit
 * ETH forwarded to the schema resolver, which is `0` for resolver-less EFS
 * schemas. EAS keeps it explicit to prevent accidental sends; we preserve that
 * by letting callers set it, while defaulting to the safe value.
 */
export interface AttestationRequestData {
  /** The recipient of the attestation (may be the zero address). */
  recipient: Address
  /** Unix expiration timestamp; `0n` means non-expiring (`NO_EXPIRATION_TIME`). */
  expirationTime: bigint
  /** Whether this attestation may later be revoked. */
  revocable: boolean
  /** UID of a related attestation, or the zero bytes32 (`EMPTY_UID`) for none. */
  refUID: Hex
  /** ABI-encoded attestation payload (see `SchemaEncoder.encodeData`). */
  data: Hex
  /** Explicit ETH forwarded to the resolver. Defaults to `0n`. */
  value?: bigint
}

/** `AttestationRequest` (IEAS.sol:20-23): a schema UID plus one data entry. */
export interface AttestationRequest {
  /** The schema UID to attest against. */
  schema: Hex
  /** The single attestation's data. */
  data: AttestationRequestData
}

/** `MultiAttestationRequest` (IEAS.sol:35-38): a schema UID plus many entries. */
export interface MultiAttestationRequest {
  /** The schema UID shared by every entry in `data`. */
  schema: Hex
  /** The attestation data entries, all under `schema`. */
  data: readonly AttestationRequestData[]
}

const ZERO_VALUE = 0n

/** Normalize one request-data entry, defaulting `value` to `0n`. */
function normalizeData(d: AttestationRequestData) {
  return {
    recipient: d.recipient,
    expirationTime: d.expirationTime,
    revocable: d.revocable,
    refUID: d.refUID,
    data: d.data,
    value: d.value ?? ZERO_VALUE,
  } as const
}

/**
 * The shape consumed by viem's `writeContract` / `simulateContract`: an
 * `address` plus the matched `abi`, `functionName`, and `args`. Callers add
 * `account`, `chain`, and any `value`/gas overrides at the call site.
 */
export interface ContractCall<TFunctionName extends string, TArgs> {
  /** The EAS contract address to call. */
  address: Address
  /** The vendored EAS ABI (`easAbi`). */
  abi: typeof easAbi
  /** The function being invoked. */
  functionName: TFunctionName
  /** The positional argument tuple. */
  args: TArgs
}

/**
 * Build the `writeContract` args for a single `attest` call. Pure: returns the
 * request, executes nothing.
 */
export function buildAttest(
  easAddress: Address,
  request: AttestationRequest,
): ContractCall<'attest', readonly [{ schema: Hex; data: ReturnType<typeof normalizeData> }]> {
  return {
    address: easAddress,
    abi: easAbi,
    functionName: 'attest',
    args: [{ schema: request.schema, data: normalizeData(request.data) }] as const,
  }
}

/**
 * Build the `writeContract` args for a `multiAttest` call. Requests should be
 * grouped by distinct schema for EAS's batching optimization (IEAS.sol:162-163).
 * Pure: returns the request, executes nothing.
 */
export function buildMultiAttest(
  easAddress: Address,
  requests: readonly MultiAttestationRequest[],
): ContractCall<
  'multiAttest',
  readonly [readonly { schema: Hex; data: readonly ReturnType<typeof normalizeData>[] }[]]
> {
  const multiRequests = requests.map((r) => ({
    schema: r.schema,
    data: r.data.map(normalizeData),
  }))
  return {
    address: easAddress,
    abi: easAbi,
    functionName: 'multiAttest',
    args: [multiRequests] as const,
  }
}
