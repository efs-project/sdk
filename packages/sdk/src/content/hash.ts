/**
 * Content hashing for EFS files.
 *
 * Convention (ADR-0006): a file's `contentHash` is a **bare SHA-256** digest as a
 * lowercase hex string (64 chars, no `0x` prefix) — byte-identical to `sha256sum`.
 * The PROPERTY *key* `contentHash` denotes the algorithm (SHA-256); a future
 * algorithm would use a new key, never a tag inside this value. See
 * docs/specs/content-hash.md.
 */

import { sha256 } from 'viem'

/** SHA-256 of the file bytes, as a bare lowercase-hex string (matches `sha256sum`). */
export function hashContent(bytes: Uint8Array): string {
  return sha256(bytes, 'hex').slice(2) // strip the 0x viem prepends
}

/** Verification status of fetched bytes against an attested `contentHash`. */
export type VerificationStatus =
  | 'matches-author' // bytes hash equals the contentHash attested by the resolving lens
  | 'no-claim' // the resolving lens attested no contentHash — UNVERIFIABLE, not "ok"
  | 'mismatch' // bytes do not match the attested contentHash (or exceed declared size)

/**
 * Verify fetched bytes against the author's attested contentHash.
 * `claimedHash` MUST come from the attester whose lens won placement (read's
 * `resolvedBy`) — verification is trust-relative, not absolute integrity.
 * `undefined` claimedHash → 'no-claim' (caller must treat as unverifiable).
 */
export function verifyContent(bytes: Uint8Array, claimedHash: string | undefined): VerificationStatus {
  if (claimedHash === undefined) return 'no-claim'
  const claim = claimedHash.toLowerCase()
  // A malformed claim (0x-prefixed, padded, wrong length) cannot be trusted → mismatch.
  if (!/^[0-9a-f]{64}$/.test(claim)) return 'mismatch'
  return hashContent(bytes) === claim ? 'matches-author' : 'mismatch'
}
