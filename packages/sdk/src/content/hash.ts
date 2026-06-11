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

/** A validated bare SHA-256 content digest (64 lowercase hex chars, no `0x`).
 * Branded (review A5) because the hash is load-bearing: it must come from a
 * trusted constructor (`hashContent`) or the `asContentHash` coercer, never an
 * arbitrary string. */
export type ContentHash = string & { readonly __brand: 'ContentHash' }

/** SHA-256 of the file bytes, as a bare lowercase-hex string (matches `sha256sum`).
 * The trusted constructor for `ContentHash`. */
export function hashContent(bytes: Uint8Array): ContentHash {
  return sha256(bytes, 'hex').slice(2) as ContentHash // strip the 0x viem prepends
}

/** Coerce a deserialized string (e.g. from a persisted receipt) into a
 * `ContentHash`, or `undefined` if it isn't a well-formed bare SHA-256 digest. */
export function asContentHash(s: string): ContentHash | undefined {
  return /^[0-9a-f]{64}$/.test(s) ? (s as ContentHash) : undefined
}

/** Verification status of fetched bytes against an attested `contentHash`. */
export type VerificationStatus =
  | 'matches-author' // bytes hash equals the contentHash attested by the resolving lens
  | 'no-claim' // the resolving lens attested no contentHash — UNVERIFIABLE, not "ok"
  | 'mismatch' // bytes do not match the attested contentHash (or exceed declared size)
  | 'malformed-claim' // the attested claim isn't a well-formed hash (attester bug, not tampering)

/**
 * Verify fetched bytes against the author's attested contentHash.
 * `claimedHash` MUST come from the attester whose lens won placement (read's
 * `resolvedBy`) — verification is trust-relative, not absolute integrity.
 * `undefined` claimedHash → 'no-claim' (caller must treat as unverifiable).
 */
export function verifyContent(
  bytes: Uint8Array,
  claimedHash: string | undefined,
): VerificationStatus {
  if (claimedHash === undefined) return 'no-claim'
  const claim = claimedHash.toLowerCase()
  // A claim that isn't a well-formed bare SHA-256 (0x-prefixed, padded, wrong
  // length) is an authoring bug, not content tampering (review A9) — distinguish
  // it from a real content/hash divergence so callers can tell the two apart.
  if (!/^[0-9a-f]{64}$/.test(claim)) return 'malformed-claim'
  return hashContent(bytes) === claim ? 'matches-author' : 'mismatch'
}
