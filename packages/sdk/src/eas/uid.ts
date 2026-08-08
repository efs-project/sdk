/**
 * Attestation UID derivation, matching EAS's on-chain `_getUID`.
 *
 * EAS computes a UID as (EAS.sol `_getUID`, lines 697-712):
 *
 *   keccak256(abi.encodePacked(
 *     attestation.schema,          // bytes32
 *     attestation.recipient,       // address
 *     attestation.attester,        // address
 *     attestation.time,            // uint64
 *     attestation.expirationTime,  // uint64
 *     attestation.revocable,       // bool
 *     attestation.refUID,          // bytes32
 *     attestation.data,            // bytes
 *     bump                         // uint32
 *   ))
 *
 * IMPORTANT — this is a VERIFICATION helper, not a predictor. `time` is the
 * block timestamp the EAS contract stamps at mine-time, and `bump` is incremented
 * by the contract on UID collisions; the SDK cannot know either before the tx is
 * mined. So you cannot compute a UID up front and watch for it. Use this to
 * RE-DERIVE a UID from a mined `Attestation` (e.g. one returned by
 * `getAttestation`) and assert it equals the on-chain `uid` — a cheap integrity
 * check that the indexer/RPC returned a self-consistent attestation.
 */

import { type Address, type Hex, encodePacked, keccak256 } from 'viem'
import { EfsError } from '../errors.js'

/** Inputs to `computeAttestationUID`, named to match the `Attestation` struct. */
export interface AttestationUIDInput {
  /** The schema UID (bytes32). */
  schema: Hex
  /** The attestation recipient. */
  recipient: Address
  /** The attester (sender). */
  attester: Address
  /** Creation time the contract stamped (uint64, Unix seconds) — known only post-mine. */
  time: bigint
  /** Expiration time (uint64); `0n` for non-expiring. */
  expirationTime: bigint
  /** Whether the attestation is revocable. */
  revocable: boolean
  /** Related attestation UID, or the zero bytes32. */
  refUID: Hex
  /** The ABI-encoded attestation data. */
  data: Hex
  /** Collision bump the contract used (uint32); `0` for the first/only attestation in a tx. */
  bump: number
}

/**
 * Re-derive an attestation UID from its (mined) field values, matching the
 * on-chain `_getUID` packed-encoding byte-for-byte.
 *
 * @see EAS.sol `_getUID` (lines 697-712).
 */
export function computeAttestationUID(input: AttestationUIDInput): Hex {
  return keccak256(
    encodePacked(
      [
        'bytes32', // schema
        'address', // recipient
        'address', // attester
        'uint64', // time
        'uint64', // expirationTime
        'bool', // revocable
        'bytes32', // refUID
        'bytes', // data
        'uint32', // bump
      ],
      [
        input.schema,
        input.recipient,
        input.attester,
        input.time,
        input.expirationTime,
        input.revocable,
        input.refUID,
        input.data,
        input.bump,
      ],
    ),
  )
}

/** The practical ceiling on {@link verifyAttestationUID}'s synchronous bump
 * scan. The wire format allows a uint32 bump, but a bump above N requires one
 * tx to have minted >N attestations with IDENTICAL fields — real batches sit
 * far below this, and 1024 keccaks stay sub-millisecond while the wire maximum
 * (4.3 billion) would freeze the event loop. */
export const MAX_UID_BUMP_SCAN = 1024

/** A mined `Attestation` shaped like the `getAttestation` return (Common.sol:26-37). */
export interface MinedAttestation {
  uid: Hex
  schema: Hex
  time: bigint
  expirationTime: bigint
  revocationTime: bigint
  refUID: Hex
  recipient: Address
  attester: Address
  revocable: boolean
  data: Hex
}

/**
 * Verify that a mined attestation's `uid` is self-consistent with its fields.
 *
 * Tries `bump = 0` first (the overwhelmingly common case — one attestation per
 * schema per tx), then scans up to `maxBump` to tolerate UID-collision bumps.
 * Returns `true` iff some `bump` in `[0, maxBump]` reproduces `attestation.uid`.
 */
export function verifyAttestationUID(attestation: MinedAttestation, maxBump = 0): boolean {
  // This loop is SYNCHRONOUS keccak work, so the accepted bound is a PRACTICAL
  // scan budget, not the uint32 wire range — a non-matching UID at the wire
  // maximum would mean 4.3 BILLION hashes freezing the event loop. A bump only
  // exceeds N when one tx minted >N attestations with IDENTICAL fields; real
  // batches sit far below {@link MAX_UID_BUMP_SCAN} (a sub-millisecond scan).
  // `NaN`/fractional/negative would instead skip even bump 0 (a false negative).
  if (!Number.isInteger(maxBump) || maxBump < 0 || maxBump > MAX_UID_BUMP_SCAN) {
    throw new EfsError(
      `verifyAttestationUID: \`maxBump\` is ${String(maxBump)} — pass an integer in [0, ${MAX_UID_BUMP_SCAN}] (the practical scan budget; the default 0 covers the common one-attestation-per-tx case). A real bump exceeds N only when one tx minted >N attestations with identical fields.`,
      { code: 'InvalidArgument' },
    )
  }
  for (let bump = 0; bump <= maxBump; bump++) {
    const derived = computeAttestationUID({
      schema: attestation.schema,
      recipient: attestation.recipient,
      attester: attestation.attester,
      time: attestation.time,
      expirationTime: attestation.expirationTime,
      revocable: attestation.revocable,
      refUID: attestation.refUID,
      data: attestation.data,
      bump,
    })
    if (derived.toLowerCase() === attestation.uid.toLowerCase()) return true
  }
  return false
}
