/**
 * The canonical anchor-segment codec — ONE implementation of the ratified v1
 * name encoding (contracts specs/02 §"Canonical anchor-name encoding" +
 * `EFSIndexer._isValidAnchorName`, mirrored byte-for-byte).
 *
 * ## The encoding (two steps)
 *
 *  1. **Unicode NFC normalization** (client-side — the resolver cannot verify
 *     it; a non-normalized input mints a DIFFERENT permanent anchor slot that
 *     silently misses the Schelling point).
 *  2. **Percent-encoding of the reserved byte set**, UPPERCASE hex. All other
 *     bytes — including ≥0x80 UTF-8 bytes — stay literal (`é` is the raw two
 *     bytes `C3 A9`, NOT `%C3%A9`; `encodeURIComponent` is the wrong tool and
 *     its output REVERTS on-chain via the over-escape rule).
 *
 * Reserved set (must be `%XX`-escaped): C0 controls `0x00–0x1F`, DEL `0x7F`,
 * space `0x20`, `%` `0x25` (itself), and the URI/path-special bytes
 * `" # & / : = ? @ [ \ ] ^ ` { | }`.
 *
 * ## One valid spelling per name (the contract's reject rules, all mirrored)
 *
 *  - empty, `.` and `..` (reserved relative segments);
 *  - a bare reserved byte;
 *  - a malformed/truncated escape (`%`, `%2`, `%ZZ`);
 *  - a lowercase-hex escape (`%2f` — only `%2F` is canonical);
 *  - an **over-escape**: a well-formed uppercase `%XX` whose decoded byte is
 *    NOT reserved (`%41` for `A`, `%2E` for `.`) — unreserved bytes must appear
 *    bare. (The contract enforces this; specs/02's prose reject-list omits it —
 *    flagged upstream. The SDK mirrors the ENFORCEMENT.)
 *
 * ## Human vs canonical is a TYPE, never sniffed
 *
 * A raw `string` is ALWAYS a human name; `CanonicalName` is always encoded.
 * Runtime sniffing is provably ambiguous — `100%25` is simultaneously a legal
 * human name (encoding to `100%2525`) and a legal canonical form (decoding to
 * `100%`) — so the brand is the only sound boundary. Consequently `encodeName`
 * is NOT idempotent over its own output: re-encoding a canonical string that
 * contains `%` mints a different (wrong) permanent slot. The brand makes that
 * double-encode a type error.
 */

import { EfsError } from '../errors.js'

/** A validated canonical anchor-segment string (specs/02 encoding). Branded:
 * it must come from `encodeName`, `asCanonicalName`, or the chain itself. */
export type CanonicalName = string & { readonly __brand: 'CanonicalName' }

/** Why a segment failed validation/encoding. */
export type InvalidNameReason =
  | 'empty'
  | 'dot-segment'
  | 'not-nfc'
  | 'bare-reserved-byte'
  | 'malformed-escape'
  | 'lowercase-escape'
  | 'over-escape'

/** Raised by the segment codec on an unencodable human name or a non-canonical
 * claimed-canonical string. Carries the offending segment + the rule broken. */
export class InvalidAnchorNameError extends EfsError {
  override name = 'InvalidAnchorNameError'
  /** The offending segment (human or claimed-canonical, as passed). */
  readonly segment: string
  /** Which canonical-name rule failed. */
  readonly reason: InvalidNameReason
  constructor(segment: string, reason: InvalidNameReason) {
    const rule =
      reason === 'empty' || reason === 'dot-segment'
        ? "Empty, '.' and '..' segments are reserved (specs/02)."
        : reason === 'not-nfc'
          ? 'Canonical names are Unicode-NFC-normalized (specs/02 step 1) — pass the human form through encodeName() instead.'
          : 'Canonical names have exactly one spelling: reserved bytes are %XX-escaped (UPPERCASE hex), unreserved bytes appear bare (specs/02).'
    super(`EFS name: segment '${segment}' is not a valid anchor name (${reason}). ${rule}`, {
      code: 'InvalidAnchorName',
    })
    this.segment = segment
    this.reason = reason
  }
}

/** The reserved byte set of specs/02 (excluding `%` 0x25, which the escape
 * parser handles) — mirrors `EFSIndexer._isReservedByte` exactly. */
function isReservedByte(b: number): boolean {
  if (b < 0x20 || b === 0x7f) return true // C0 controls + DEL
  switch (b) {
    case 0x20: // space
    case 0x22: // "
    case 0x23: // #
    case 0x26: // &
    case 0x2f: // /
    case 0x3a: // :
    case 0x3d: // =
    case 0x3f: // ?
    case 0x40: // @
    case 0x5b: // [
    case 0x5c: // \
    case 0x5d: // ]
    case 0x5e: // ^
    case 0x60: // `
    case 0x7b: // {
    case 0x7c: // |
    case 0x7d: // }
      return true
    default:
      return false
  }
}

const UPPER_HEX = '0123456789ABCDEF'

function isUpperHexChar(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')
}

/**
 * Encode a HUMAN segment to its canonical on-chain form: NFC then uppercase
 * percent-encoding of the reserved set. The trusted constructor for
 * {@link CanonicalName}.
 *
 * Guarantees: `decodeName(encodeName(h)) === h.normalize('NFC')` and
 * `encodeName(decodeName(c)) === c`. NOT idempotent over its own output (see
 * the module doc) — never pass a `CanonicalName` back in.
 *
 * @throws {InvalidAnchorNameError} on `''`, `'.'`, or `'..'` (after NFC).
 */
export function encodeName(human: string): CanonicalName {
  const nfc = human.normalize('NFC')
  if (nfc.length === 0) throw new InvalidAnchorNameError(human, 'empty')
  if (nfc === '.' || nfc === '..') throw new InvalidAnchorNameError(human, 'dot-segment')
  // The reserved set is entirely ASCII, and a multi-byte UTF-8 sequence contains
  // only bytes ≥0x80 — so a code-point walk suffices: escape reserved ASCII,
  // keep everything else (including all non-ASCII) literal.
  let out = ''
  for (const ch of nfc) {
    const cp = ch.codePointAt(0) as number
    if (cp < 0x80 && (isReservedByte(cp) || cp === 0x25)) {
      out += `%${UPPER_HEX[(cp >> 4) & 0xf]}${UPPER_HEX[cp & 0xf]}`
    } else {
      out += ch
    }
  }
  return out as CanonicalName
}

/** Validation verdict for a claimed-canonical string — mirrors
 * `EFSIndexer._isValidAnchorName` byte-for-byte (over-escape rejection
 * included) PLUS the NFC rule the contract cannot check but the SDK can:
 * specs/02 canonical = NFC + escaping, so a non-NFC string is NOT canonical —
 * admitting one would let `asCanonicalName`/the graph dev-guard pass an NFD
 * segment that mints a permanent anchor slot the (NFC-normalizing) path
 * pipeline can never resolve. Returns the failing rule, or `undefined`. */
function validateCanonical(s: string): InvalidNameReason | undefined {
  if (s.length === 0) return 'empty'
  if (s === '.' || s === '..') return 'dot-segment'
  if (s !== s.normalize('NFC')) return 'not-nfc'
  const bytes = new TextEncoder().encode(s)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    if (b === 0x25) {
      if (i + 2 >= bytes.length) return 'malformed-escape'
      const h1 = String.fromCharCode(bytes[i + 1] as number)
      const h2 = String.fromCharCode(bytes[i + 2] as number)
      if (!isUpperHexChar(h1) || !isUpperHexChar(h2)) {
        // Distinguish the lowercase case for a better error; the contract
        // rejects both identically.
        return /[a-f]/.test(h1) || /[a-f]/.test(h2) ? 'lowercase-escape' : 'malformed-escape'
      }
      const decoded = Number.parseInt(h1 + h2, 16)
      if (!isReservedByte(decoded) && decoded !== 0x25) return 'over-escape'
      i += 2
    } else if (isReservedByte(b)) {
      return 'bare-reserved-byte'
    }
  }
  return undefined
}

/** Type guard: is `s` a canonical anchor name (would the resolver accept it)? */
export function isCanonicalName(s: string): s is CanonicalName {
  return validateCanonical(s) === undefined
}

/** Coerce an already-canonical string (chain-sourced, or a caller who encoded
 * upstream) into the brand, validating it first.
 * @throws {InvalidAnchorNameError} if it is not canonical. */
export function asCanonicalName(s: string): CanonicalName {
  const reason = validateCanonical(s)
  if (reason !== undefined) throw new InvalidAnchorNameError(s, reason)
  return s as CanonicalName
}

/**
 * Decode a canonical segment back to its HUMAN form (unescape `%XX`, UTF-8
 * decode). Strict: validates first, so a non-canonical input throws rather
 * than silently mis-decoding.
 * @throws {InvalidAnchorNameError} if `canonical` is not canonical.
 */
export function decodeName(canonical: string): string {
  const reason = validateCanonical(canonical)
  if (reason !== undefined) throw new InvalidAnchorNameError(canonical, reason)
  const bytes = new TextEncoder().encode(canonical)
  const out = new Uint8Array(bytes.length)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    if (b === 0x25) {
      const h1 = String.fromCharCode(bytes[i + 1] as number)
      const h2 = String.fromCharCode(bytes[i + 2] as number)
      out[n++] = Number.parseInt(h1 + h2, 16)
      i += 2
    } else {
      out[n++] = b
    }
  }
  return new TextDecoder().decode(out.slice(0, n))
}
