/**
 * Content hashing for EFS files — the `contentHash` codec.
 *
 * Convention (contracts specs/10 + contracts ADR-0064; SDK ADR-0016, superseding
 * ADR-0006): a file's `contentHash` PROPERTY value is a **multibase-prefixed
 * multihash** string. The canonical written form is base16 (`f`) over
 * `<hashFnCode><digestLen><digest>`: for the canonical/default sha2-256 that is
 * the literal `f1220` followed by the 64 lowercase-hex digest chars (69 chars
 * total). Readers accept both `f`/base16 and `b`/base32 (RFC 4648 lowercase,
 * no padding) and dispatch on the multihash function code — `0x12` sha2-256
 * (canonical), `0x1b` keccak-256 (optional alternate). Those two codes are the
 * ONLY registered functions at genesis (specs/10 §2.1); an unregistered code is
 * a permanent, unverifiable value and reads as `malformed-claim`.
 *
 * A bare 64-hex digest (the superseded ADR-0006 form) is algorithm-ambiguous
 * (specs/10 §1) and also reads as `malformed-claim` — verification compares at
 * the DIGEST level after decoding, never by string equality, so a `b…` base32
 * claim of the same digest still verifies. See docs/specs/content-hash.md.
 */

import { keccak256, sha256 } from 'viem'

/** Multihash function codes registered for `contentHash` at genesis
 * (specs/10 §2.1). Closed set — a writer MUST NOT emit any other code. */
export const CONTENT_HASH_CODES = {
  'sha2-256': 0x12,
  'keccak-256': 0x1b,
} as const

/** A hash algorithm the `contentHash` format can carry (specs/10 §2.1). */
export type ContentHashAlgorithm = keyof typeof CONTENT_HASH_CODES

/** A validated CANONICAL `contentHash` string — the multibase-base16 multihash
 * form (`f1220<64 hex>` sha2-256, or the `f1b20…` keccak-256 alternate).
 * Branded (review A5) because the hash is load-bearing: it must come from a
 * trusted constructor (`hashContent`), the `asContentHash` coercer, or
 * `decodeContentHash(...).canonical`, never an arbitrary string. */
export type ContentHash = string & { readonly __brand: 'ContentHash' }

/** The canonical `contentHash` of `bytes`: `f1220` + sha2-256 lowercase hex
 * (specs/10 §2.3 — sha2-256 is the ratified canonical/default function, sharing
 * its digest with the file's IPFS CIDv1). The trusted constructor for
 * `ContentHash`. */
export function hashContent(bytes: Uint8Array): ContentHash {
  return `f1220${sha256(bytes, 'hex').slice(2)}` as ContentHash // strip viem's 0x
}

/** Canonical base16 forms only: `f` + (`1220` | `1b20`) + 64 lowercase hex. */
const CANONICAL_RE = /^f1(?:2|b)20[0-9a-f]{64}$/

/** Coerce a deserialized string (e.g. from a persisted receipt) into a
 * `ContentHash`, or `undefined` if it isn't a CANONICAL base16 multihash form
 * of a registered algorithm. Accepted-on-read forms (`b…` base32) are NOT
 * canonical — route them through {@link decodeContentHash} and use its
 * `.canonical`. */
export function asContentHash(s: string): ContentHash | undefined {
  return CANONICAL_RE.test(s) ? (s as ContentHash) : undefined
}

/** RFC 4648 base32, lowercase, no padding (multibase `b`, specs/10 §2.2). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Decode RFC 4648 lowercase no-padding base32, or `undefined` if malformed
 * (wrong alphabet, uppercase, `=` padding, or dangling bits that don't form a
 * whole byte). Hand-rolled (~20 lines) rather than a multiformats dependency —
 * the size gate and the viem-only rule (ADR-0002) both argue against a dep. */
function decodeBase32(s: string): Uint8Array | undefined {
  if (s.length === 0) return undefined
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) return undefined
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >> bits) & 0xff)
    }
  }
  // Trailing bits must be zero-padding of the final byte, per RFC 4648.
  if ((value & ((1 << bits) - 1)) !== 0) return undefined
  return Uint8Array.from(out)
}

/** Decode lowercase hex (multibase `f` = base16-lower — uppercase/mixed case is
 * NOT canonical and rejected, specs/10 §2.2), or `undefined` if malformed. */
function decodeBase16Lower(s: string): Uint8Array | undefined {
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-f]+$/.test(s)) return undefined
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** A decoded, validated `contentHash` claim. */
export type DecodedContentHash = {
  /** Which registered hash function the claim names (multihash code). */
  algorithm: ContentHashAlgorithm
  /** The 32 digest bytes. */
  digest: Uint8Array
  /** The canonical base16 re-encoding — use THIS for interning/dedup lookups:
   * two encodings of one digest are distinct interned on-chain values
   * (specs/10 §2.2), so value-keyed lookups must go through the canonical form. */
  canonical: ContentHash
}

/**
 * Decode an accepted-form `contentHash` string (specs/10 §2.2): `f`/base16 or
 * `b`/base32, carrying a registered function code (`0x12` sha2-256, `0x1b`
 * keccak-256) and a 32-byte digest. Returns `undefined` for anything else —
 * bare digests, `0x`-prefixed hex, uppercase, padding, unregistered codes
 * (closed registry at genesis, specs/10 §2.1), or wrong digest length.
 */
export function decodeContentHash(s: string): DecodedContentHash | undefined {
  if (s.length < 2) return undefined
  const body = s.slice(1)
  const bytes =
    s[0] === 'f' ? decodeBase16Lower(body) : s[0] === 'b' ? decodeBase32(body) : undefined
  if (bytes === undefined || bytes.length !== 34) return undefined
  const code = bytes[0] ?? 0
  const algorithm =
    code === CONTENT_HASH_CODES['sha2-256']
      ? ('sha2-256' as const)
      : code === CONTENT_HASH_CODES['keccak-256']
        ? ('keccak-256' as const)
        : undefined
  if (algorithm === undefined || bytes[1] !== 0x20) return undefined
  const digest = bytes.slice(2)
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return {
    algorithm,
    digest,
    canonical: `f${code.toString(16).padStart(2, '0')}20${hex}` as ContentHash,
  }
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
 *
 * The claim is decoded per specs/10 §6: the multihash code names the function
 * to run, and comparison is at the DIGEST level — so a `b…` base32 claim or an
 * `f1b20…` keccak alternate of matching content verifies 'matches-author'.
 * A claim that doesn't decode (bare digest, unregistered code, wrong case…) is
 * an authoring bug, not content tampering (review A9) → 'malformed-claim'.
 */
export function verifyContent(
  bytes: Uint8Array,
  claimedHash: string | undefined,
): VerificationStatus {
  if (claimedHash === undefined) return 'no-claim'
  const decoded = decodeContentHash(claimedHash)
  if (decoded === undefined) return 'malformed-claim'
  const fn = decoded.algorithm === 'sha2-256' ? sha256 : keccak256
  const computed = fn(bytes, 'hex').slice(2) // strip viem's 0x
  let claimed = ''
  for (const b of decoded.digest) claimed += b.toString(16).padStart(2, '0')
  return computed === claimed ? 'matches-author' : 'mismatch'
}
