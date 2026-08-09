/**
 * Transport resolution — parse a mirror URI into the concrete HTTP(S) URLs the
 * fetch engine will try. Freeze-independent: this layer has nothing to do with
 * attestations, only with *where the bytes live*.
 *
 * Doctrine (future-proofing.md §2, standards.md "Content addressing"):
 *   - `ipfs://`/`ar://`/`https://` ADOPT; `data:` SEAM (tiny inline content);
 *     `web3://` we own — it resolves to on-chain (SSTORE2) bytes via a chain client,
 *     handled in `fetch.ts` (the injected `web3Reader`), not here; this layer keeps
 *     the `httpUrls()` NotImplemented seam as the fallback when no reader is wired.
 *     `magnet://` parse-only (no HTTP resolution).
 *   - CID is a *locator only* — never a verification input (a raw CIDv1 shares
 *     the canonical sha2-256 digest, specs/10 §4, but dag-pb/chunked CIDs do not).
 *     We always re-verify fetched bytes against the attested `contentHash`.
 *   - Multi-gateway fallback: a transport can expand to several candidate URLs;
 *     the fetch engine tries them in order (public gateways die / rate-limit /
 *     turn hostile — assume any single one is unreliable).
 */

import type { TransportName } from '../types.js'
import { DEFAULT_MAX_BYTES } from './fetch.js'

/** Value-level allowlist of known transports (ADR-0010). Keys match
 * `TransportName`. This is the *recognized* set; `TransportName` stays an open
 * union so an unknown scheme is still assignable, but only these resolve. */
export const TRANSPORT = {
  web3: 'web3',
  arweave: 'arweave',
  ipfs: 'ipfs',
  magnet: 'magnet',
  https: 'https',
  data: 'data',
} as const satisfies Record<string, TransportName>

/** Default IPFS gateways, tried in order. Trustless-friendly: for a bare
 * RAW-block CID we request `?format=raw` (IPIP-402) so the gateway returns the
 * block bytes rather than a transcoded representation. UnixFS/dag-pb CIDs and
 * subpaths take the gateway's normal file response instead — their raw block is
 * a protobuf wrapper, not the payload. Either way the gateway is never trusted:
 * the fetch engine re-hashes every byte against the attested `contentHash`.
 * Overridable via `ResolveOptions.ipfsGateways`. */
export const DEFAULT_IPFS_GATEWAYS: readonly string[] = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://trustless-gateway.link',
]

/** Default Arweave gateways, tried in order. Overridable via
 * `ResolveOptions.arweaveGateways`. */
export const DEFAULT_ARWEAVE_GATEWAYS: readonly string[] = [
  'https://arweave.net',
  'https://ar-io.net',
]

/** Gateway overrides for resolution. */
export type ResolveOptions = {
  /** IPFS gateway origins (e.g. `https://ipfs.io`), tried in order. */
  ipfsGateways?: readonly string[]
  /** Arweave gateway origins (e.g. `https://arweave.net`), tried in order. */
  arweaveGateways?: readonly string[]
}

/** A `data:` URI decoded inline — no network fetch is needed. */
export type InlineData = {
  /** The declared media type (informational only — never used to decide
   * handling; see the nosniff doctrine in fetch.ts). */
  contentType?: string
  /** The decoded payload bytes. */
  bytes: Uint8Array
}

/** A parsed mirror URI ready for the fetch engine. */
export type ResolvedTransport = {
  /** The recognized transport scheme. */
  scheme: TransportName
  /** The original URI, normalized. */
  uri: string
  /**
   * Candidate HTTP(S) URLs to try in order, given a set of gateways.
   * Empty for `data:` (the bytes are `inline`) and for `magnet:`/`web3:`
   * (no HTTP resolution path here).
   */
  httpUrls(opts?: ResolveOptions): URL[]
  /** Decoded inline bytes, present only for `data:` URIs. */
  inline?: InlineData
}

/** Thrown when a transport is recognized but cannot be resolved to HTTP URLs
 * in this layer (the clear seam for `web3://`). */
export class TransportNotImplementedError extends Error {
  override readonly name = 'TransportNotImplementedError'
  readonly scheme: TransportName
  constructor(scheme: TransportName, detail: string) {
    super(`transport "${scheme}" resolution is not implemented: ${detail}`)
    this.scheme = scheme
  }
}

/**
 * Short, safe summary of a mirror URI for error/log output. A `data:` body is
 * elided (just scheme+media type + a byte count) and any over-long URI is
 * truncated — so rejecting an oversized untrusted payload never copies the whole
 * thing into an Error message or attempt record.
 */
export function summarizeUri(uri: string): string {
  // Redaction decisions run on the TRIMMED string (r3742980319). Both tests
  // below are anchored, so a single leading space made `" data:…"` look like a
  // non-data URI and printed 200 characters of the inline payload — and did the
  // same for a whitespace-prefixed credential URL. The write path rejects
  // surrounding whitespace, but this function also serves READS: `fetchVerified`
  // can be called directly, and the chain is append-only, so legacy or foreign
  // mirrors carry whatever they were minted with.
  //
  // Normalizing HERE rather than at the call sites, deliberately: an earlier fix
  // passed `uri.trim()` at one caller and left every other one leaking.
  const trimmed = uri.trim()
  if (/^data:/i.test(trimmed)) {
    const comma = trimmed.indexOf(',')
    const meta = (comma === -1 ? trimmed : trimmed.slice(0, comma)).slice(0, 80)
    const bodyLen = comma === -1 ? 0 : trimmed.length - comma - 1
    return `${meta},<${bodyLen} chars elided>`
  }
  // Strip a `user:password@` userinfo component (r3742879885). The write path
  // now refuses these outright, but this function is what every error and
  // attempt record flows through — INCLUDING that refusal's own message — and
  // the chain is append-only, so a credential-bearing mirror minted before this
  // guard still reaches readers. String surgery, not `new URL`: the input here
  // is arbitrary and may not parse at all.
  //
  // `[^/?#]*` is GREEDY on purpose, so it runs to the LAST `@` of the authority
  // — WHATWG's own delimiter rule (r3742898918). A raw `@` inside the password
  // is legal, and `https://alice:p@ss@host/f` parses as password `p@ss`; a
  // first-`@` match would redact only `alice:p` and print `ss@` to the log.
  // Excluding `/?#` keeps an `@` in a path, query or fragment untouched.
  const safe = trimmed.replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/,
    '$1<credentials redacted>@',
  )
  return safe.length > 200 ? `${safe.slice(0, 200)}… (${safe.length} chars)` : safe
}

/** Thrown when a URI cannot be parsed or its scheme is unrecognized. */
export class UnsupportedUriError extends Error {
  override readonly name = 'UnsupportedUriError'
  constructor(uri: string, detail: string) {
    super(`unsupported mirror URI "${summarizeUri(uri)}": ${detail}`)
  }
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/**
 * The lowercased RFC 3986 scheme of `uri`, or `undefined` when the string does
 * not START with a syntactically valid one.
 *
 * Exported so the WRITE preflight parses schemes exactly as the reader does
 * (r3742660066). The preflight previously carried its own copy of this pattern,
 * and a locator the reader considers schemeless — `"https ://…"`, with a space
 * before the colon — slipped through the copy as a "custom" transport and
 * minted a mirror no read could ever parse.
 */
export function uriScheme(uri: string): string | undefined {
  return SCHEME_RE.exec(uri)?.[1]?.toLowerCase()
}

/** Strip a trailing slash from a gateway origin so we can concatenate paths. */
function trimGateway(g: string): string {
  return g.endsWith('/') ? g.slice(0, -1) : g
}

/**
 * Build a gateway URL for `<nsSegments><subpath>` and verify the subpath cannot
 * escape the content-address namespace. `new URL` normalizes `..` AND `%2e%2e`
 * (WHATWG decodes percent-encoded dots during dot-segment removal), so a mirror
 * like `ipfs://cid/%2e%2e/admin` would otherwise resolve to `/admin` on the
 * trusted gateway. We assert the post-normalization pathname still begins with
 * the intended namespace and reject otherwise.
 */
function buildGatewayUrl(gateway: string, nsSegments: string, subpath: string, uri: string): URL {
  const gw = new URL(trimGateway(gateway))
  const basePath = gw.pathname.endsWith('/') ? gw.pathname.slice(0, -1) : gw.pathname
  const nsPath = `${basePath}/${nsSegments}`
  const u = new URL(`${nsPath}${subpath}`, gw.origin)
  // Require an exact match or a `/` boundary — a bare prefix check would let
  // `../<cid>admin` pass (`/ipfs/bafyadmin` startsWith `/ipfs/bafy`).
  if (u.pathname !== nsPath && !u.pathname.startsWith(`${nsPath}/`)) {
    throw new UnsupportedUriError(uri, 'subpath escapes the content-address namespace')
  }
  return u
}

/**
 * Parse a mirror URI into a {@link ResolvedTransport}. Does NOT fetch — purely
 * structural. Throws {@link UnsupportedUriError} for unknown schemes and
 * {@link TransportNotImplementedError} for recognized-but-unresolvable ones
 * (`web3://`).
 */
export function resolveTransport(
  uri: string,
  opts: { maxBytes?: number; allowInsecureHttp?: boolean } = {},
): ResolvedTransport {
  // Direct callers of this PUBLIC resolver bypass fetchVerified's cap check, and
  // every downstream size comparison in `resolveData` is a `>` — NaN never
  // rejects an oversized `data:` payload and Infinity disables the ceiling.
  // Same fail-loud rule as fetchVerified, at this entry point too.
  if (opts.maxBytes !== undefined && (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0)) {
    throw new RangeError(
      `resolveTransport: \`maxBytes\` must be a finite positive number (got ${opts.maxBytes}). Omit it for the default ceiling.`,
    )
  }
  const scheme = uriScheme(uri)
  if (!scheme) {
    throw new UnsupportedUriError(uri, 'no URI scheme')
  }

  switch (scheme) {
    case 'https':
    case 'http': {
      // ADR-0010 names `https://` as the web transport. Plaintext `http://` is
      // rejected by DEFAULT: bytes are hash-verified, but availability, privacy,
      // and provenance over cleartext are tamperable — an attacker-authored mirror
      // could downgrade retrieval to HTTP. Opt back in with `allowInsecureHttp`
      // (e.g. a trusted local mirror) — the same escape-hatch posture as the SSRF
      // guard. `https://` is unaffected.
      if (scheme === 'http' && opts.allowInsecureHttp !== true) {
        throw new UnsupportedUriError(
          uri,
          'plaintext http:// is rejected (set allowInsecureHttp to opt in); use https://',
        )
      }
      let parsed: URL
      try {
        parsed = new URL(uri)
      } catch {
        throw new UnsupportedUriError(uri, 'malformed https URL')
      }
      // `new URL` happily accepts `https://user:pass@host/…`, but WHATWG `fetch`
      // REFUSES to construct a Request from a URL carrying credentials — it
      // throws before any network call, so such a mirror confirms on-chain and
      // then fails every read with AllMirrorsFailed (r3742879885). Refused at
      // parse so the write preflight catches it, rather than minting a locator
      // our own fetch can never use.
      if (parsed.username !== '' || parsed.password !== '') {
        throw new UnsupportedUriError(
          uri,
          'URL carries credentials (user:password@), which fetch refuses to request — publish a URL without embedded credentials',
        )
      }
      return {
        scheme: TRANSPORT.https,
        uri,
        httpUrls: () => [new URL(parsed.href)],
      }
    }

    case 'ipfs':
      return resolveIpfs(uri)

    case 'ar':
    case 'arweave':
      return resolveArweave(uri)

    case 'data':
      // The DEFAULT ceiling applies here too (r3741562782): the standalone
      // exported parser previously forwarded `undefined`, letting an untrusted
      // data: URI materialize an arbitrarily large payload — only callers
      // routed through fetchVerified got the 50 MB default.
      return resolveData(uri, opts.maxBytes ?? DEFAULT_MAX_BYTES)

    case 'magnet':
      // Parse-only: BitTorrent has no synchronous HTTP resolution path here.
      return {
        scheme: TRANSPORT.magnet,
        uri,
        httpUrls: () => [],
      }

    case 'web3':
      // Recognized. Resolution needs a chain client (read the SSTORE2 chunks via the
      // EFSBytesStore manager), so it is handled in fetch.ts by an injected
      // `web3Reader` — NOT via HTTP URLs. `httpUrls()` stays the NotImplemented seam
      // for the no-reader path (recorded as a failed attempt so a later mirror wins).
      return {
        scheme: TRANSPORT.web3,
        uri,
        httpUrls: () => {
          throw new TransportNotImplementedError(
            TRANSPORT.web3,
            'web3:// resolves via a chain client (mirror/web3.ts), not HTTP — wire a web3Reader',
          )
        },
      }

    default:
      throw new UnsupportedUriError(uri, `unrecognized scheme "${scheme}"`)
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_FLICKR_ALPHABET = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const BASE32_HEX_ALPHABET = '0123456789abcdefghijklmnopqrstuv'
const BASE32_Z_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const BASE16_ALPHABET = '0123456789abcdef'
/** base64url (RFC 4648 §5) — used only to range-check an Arweave tx id's final
 * character, whose low 2 bits are padding on a 32-byte hash. */
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Decode a big-endian radix-N string (base10/base36/base58/…), or `undefined`
 * when a character falls outside `alphabet`. Leading `alphabet[0]` characters
 * are leading ZERO BYTES — the base58btc `1` convention, which multibase
 * generalizes to every radix encoding.
 */
function decodeRadix(s: string, alphabet: string): Uint8Array | undefined {
  const base = alphabet.length
  const bytes: number[] = [0]
  for (const ch of s) {
    const v = alphabet.indexOf(ch)
    if (v < 0) return undefined
    let carry = v
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * base
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of s) {
    if (ch !== alphabet[0]) break
    bytes.push(0)
  }
  return new Uint8Array(bytes.reverse())
}

/**
 * Decode a bit-packed alphabet (the base2/base8/base16/base32 families) at
 * `bits` per character. `undefined` when a character falls outside `alphabet`,
 * or when the body is not a WHOLE encoding of its bytes (r3742548815).
 *
 * RFC 4648 leaves at most `bits - 1` padding bits, and they are zero. Anything
 * more is a body that decodes to bytes it does not actually spell: an extra
 * base16 nibble on a valid CID contributes no byte, so `f…40` and `f…407`
 * would decode IDENTICALLY and both clear the structural CID checks. The
 * malformed locator then mints as a file's only mirror and 404s at a strict
 * IPFS gateway — a write that confirms and can never be read. Rejecting the
 * residue is what makes the decode a real parse rather than a lossy scan.
 */
function decodeBits(s: string, alphabet: string, bits: number): Uint8Array | undefined {
  let acc = 0
  let n = 0
  const out: number[] = []
  for (const ch of s) {
    const v = alphabet.indexOf(ch)
    if (v < 0) return undefined
    acc = (acc << bits) | v
    n += bits
    if (n >= 8) {
      n -= 8
      out.push((acc >> n) & 0xff)
      acc &= (1 << n) - 1 // keep `acc` small — `<<` is a 32-bit signed op
    }
  }
  // `n >= bits` means a whole trailing character bought no byte; `acc !== 0`
  // means its bits were not the zero padding RFC 4648 requires.
  if (n >= bits || acc !== 0) return undefined
  return new Uint8Array(out)
}

/** Decode lowercase RFC 4648 base32 (no padding) — the common CIDv1 case. */
function decodeBase32Lower(s: string): Uint8Array | undefined {
  return decodeBits(s, BASE32_ALPHABET, 5)
}

/** Decode base58btc — the CIDv0 case. */
function decodeBase58(s: string): Uint8Array | undefined {
  return decodeRadix(s, BASE58_ALPHABET)
}

/** Read an unsigned varint at `i`; `undefined` when truncated/oversized. */
function readVarint(b: Uint8Array, i: number): { value: number; next: number } | undefined {
  let value = 0
  let shift = 0
  let idx = i
  for (let n = 0; n < 5; n++) {
    const byte = b[idx]
    if (byte === undefined) return undefined
    // PLAIN ARITHMETIC, not `|=` with `<<`: JS bitwise operators coerce to
    // INT32, so a fifth group silently truncated its high bits — `81 80 80 80
    // 10` encodes 4294967297 but read back as version 1, and no later check
    // could tell (r3742782641). Multiplying keeps the true value, so the
    // range test below is meaningful.
    value += (byte & 0x7f) * 2 ** shift
    idx += 1
    if ((byte & 0x80) === 0) {
      // MINIMALITY (r3742724225). unsigned-varint requires the shortest
      // encoding, so a terminal group of zero after a continuation byte carries
      // no information: `81 00` and `01` both mean 1. Accepting the redundant
      // form let a CID with a spare byte spliced in clear the whole preflight
      // while strict CID parsers and gateways reject the locator outright.
      if (n > 0 && byte === 0) return undefined
      // Every field this reads (version, codec, multihash code and length) is
      // a uint32 in practice; anything larger is a CID no parser accepts.
      if (value > 0xffffffff) return undefined
      return { value, next: idx }
    }
    shift += 7
  }
  return undefined
}

/** How one multibase encodes bytes: the alphabet, and whether the body must be
 * lower/upper case (multibase is case-significant — `f`/`F` and `k`/`K` are
 * distinct codes, not spellings of one). `mixed` bases have no case variant. */
type Multibase = {
  readonly name: string
  readonly decode: (body: string) => Uint8Array | undefined
}

const bitsBase = (
  name: string,
  alphabet: string,
  bits: number,
  casing: 'lower' | 'upper' | 'mixed',
): Multibase => ({
  name,
  decode: (body) => {
    if (casing === 'upper') {
      if (body !== body.toUpperCase()) return undefined
      return decodeBits(body.toLowerCase(), alphabet, bits)
    }
    if (casing === 'lower' && body !== body.toLowerCase()) return undefined
    return decodeBits(body, alphabet, bits)
  },
})

const radixBase = (
  name: string,
  alphabet: string,
  casing: 'lower' | 'upper' | 'mixed',
): Multibase => ({
  name,
  decode: (body) => {
    if (casing === 'upper') {
      if (body !== body.toUpperCase()) return undefined
      return decodeRadix(body.toLowerCase(), alphabet)
    }
    if (casing === 'lower' && body !== body.toLowerCase()) return undefined
    return decodeRadix(body, alphabet)
  },
})

/**
 * The multibase codes a CID may carry here, each with a real decoder — an
 * alphabet screen is not enough (`ipfs://k0000000000` is valid base36 and not
 * a CID at all, r3742184824), so every prefix below decodes to bytes that then
 * face the SAME version/codec/multihash parse.
 *
 * Restricted to the ALPHANUMERIC bases: {@link resolveIpfs} refuses any other
 * character so a crafted CID cannot smuggle path/host characters into a
 * gateway URL, and the write preflight must not admit a locator our own reader
 * would reject. The PADDED variants (`c`/`C`/`t`/`T`) are absent for exactly
 * that reason — see {@link PADDED_BASES}.
 */
const MULTIBASE: Record<string, Multibase> = {
  '0': bitsBase('base2', '01', 1, 'mixed'),
  '7': bitsBase('base8', '01234567', 3, 'mixed'),
  '9': radixBase('base10', '0123456789', 'mixed'),
  b: bitsBase('base32', BASE32_ALPHABET, 5, 'lower'),
  B: bitsBase('base32upper', BASE32_ALPHABET, 5, 'upper'),
  f: bitsBase('base16', BASE16_ALPHABET, 4, 'lower'),
  F: bitsBase('base16upper', BASE16_ALPHABET, 4, 'upper'),
  h: bitsBase('base32z', BASE32_Z_ALPHABET, 5, 'mixed'),
  k: radixBase('base36', BASE36_ALPHABET, 'lower'),
  K: radixBase('base36upper', BASE36_ALPHABET, 'upper'),
  v: bitsBase('base32hex', BASE32_HEX_ALPHABET, 5, 'lower'),
  V: bitsBase('base32hexupper', BASE32_HEX_ALPHABET, 5, 'upper'),
  z: radixBase('base58btc', BASE58_ALPHABET, 'mixed'),
  Z: radixBase('base58flickr', BASE58_FLICKR_ALPHABET, 'mixed'),
}

/**
 * The PADDED multibase codes — assigned, but unusable as an `ipfs://` locator
 * here, so they are refused BY NAME rather than decoded (r3742608266).
 *
 * These are a genuine dead end, not a gap we could close by parsing harder:
 *
 *  - Their `=` padding is REQUIRED by multibase, and {@link resolveIpfs} rejects
 *    every non-alphanumeric character — so a correctly padded CID could never be
 *    read back by our own reader.
 *  - Dropping the padding does not rescue them: the table previously decoded
 *    `c…`/`t…` with the ORDINARY unpadded routine, so `cafy…` (a valid base32
 *    CID with its prefix swapped) sailed through the write preflight while
 *    strict multibase implementations reject it — mintable as a file's only
 *    mirror, and unreadable at the gateways that matter.
 *
 * Refusing by name rather than deleting the entries: `c` IS an assigned code, so
 * "unknown multibase prefix" would be a lie, and the caller needs to be told to
 * re-encode rather than to go hunting for a typo.
 */
const PADDED_BASES: Record<string, string> = {
  c: 'base32pad',
  C: 'base32padupper',
  t: 'base32hexpad',
  T: 'base32hexpadupper',
}

/**
 * Structurally validate an IPFS CID: decode its multibase, then parse the CID
 * itself. Returns a short reason when invalid, `undefined` when it parses.
 *
 *  - CIDv0 — bare base58btc `Qm…`: a raw sha2-256 multihash (0x12 0x20 + 32B).
 *  - CIDv1 — a {@link MULTIBASE} prefix over: version varint (1) + codec
 *    varint + multihash (code, length, digest of exactly that length), with NO
 *    trailing bytes.
 *
 * EVERY accepted prefix is really decoded — there is no alphabet-only path, so
 * a well-formed string in a real base that is not a CID (`k0000000000` is
 * valid base36 and decodes to zero bytes) is refused like any other garbage
 * (r3742184824). An UNASSIGNED prefix is refused by name (r3742144268).
 */
export function cidStructureError(cid: string): string | undefined {
  const parseV1 = (bytes: Uint8Array | undefined): string | undefined => {
    if (bytes === undefined) return 'malformed multibase encoding'
    const version = readVarint(bytes, 0)
    if (version === undefined) return 'truncated CID'
    if (version.value !== 1) return `unsupported CID version ${version.value}`
    const codec = readVarint(bytes, version.next)
    if (codec === undefined) return 'truncated codec'
    const mhCode = readVarint(bytes, codec.next)
    if (mhCode === undefined) return 'truncated multihash code'
    const mhLen = readVarint(bytes, mhCode.next)
    if (mhLen === undefined) return 'truncated multihash length'
    const digestEnd = mhLen.next + mhLen.value
    if (digestEnd !== bytes.length) {
      return `multihash length ${mhLen.value} does not match the remaining ${bytes.length - mhLen.next} bytes`
    }
    if (mhLen.value === 0) return 'empty multihash digest'
    return undefined
  }

  if (cid.startsWith('Qm')) {
    const raw = decodeBase58(cid)
    if (raw === undefined) return 'malformed base58btc'
    if (raw.length !== 34 || raw[0] !== 0x12 || raw[1] !== 0x20) {
      return 'not a valid CIDv0 sha2-256 multihash'
    }
    return undefined
  }
  const prefix = cid[0]
  const body = cid.slice(1)
  if (body.length === 0) return 'missing CID body'
  const padded = prefix === undefined ? undefined : PADDED_BASES[prefix]
  if (padded !== undefined) {
    return `${padded} ('${prefix}') CIDs are not supported here — multibase REQUIRES their '=' padding, which the ipfs:// reader rejects, so the locator could never be read back; re-encode the CID as base32 ('b…') or base58btc ('z…')`
  }
  const base = prefix === undefined ? undefined : MULTIBASE[prefix]
  if (base === undefined) {
    return `unknown multibase prefix '${prefix}' (an IPFS CID starts with 'Qm', or a multibase code such as 'b', 'f', 'z' or 'k')`
  }
  const bytes = base.decode(body)
  if (bytes === undefined) return `body is not valid ${base.name}`
  return parseV1(bytes)
}

/**
 * Whether `cid` names a RAW block — the only case where a gateway's raw-block
 * response is the file's own bytes (r3742636236).
 *
 * `?format=raw` (IPIP-402) returns the serialized BLOCK. For a raw-codec
 * (`0x55`) CID that block IS the content, so the response re-hashes to
 * `contentHash`. For dag-pb/UnixFS (`0x70`) — every CIDv0 `Qm…`, and the
 * `bafybei…` CIDv1s — the block is a protobuf node WRAPPING the payload, and
 * for multi-block files it holds only links. Re-hashing that yields a digest
 * that cannot match, so a perfectly valid mirror reads back as
 * `verification: 'mismatch'` and `readBytes`/`readText` throw.
 *
 * Conservative by construction: anything we cannot positively prove to be a raw
 * block returns `false`, because the cost of guessing wrong is a file that
 * never reads, while the cost of omitting `format=raw` is only that the gateway
 * picks its own (correct) representation.
 */
function isRawBlockCid(cid: string): boolean {
  if (cid.startsWith('Qm')) return false // CIDv0 is always dag-pb
  const base = MULTIBASE[cid[0] ?? '']
  const bytes = base?.decode(cid.slice(1))
  if (bytes === undefined) return false
  const version = readVarint(bytes, 0)
  if (version?.value !== 1) return false
  return readVarint(bytes, version.next)?.value === 0x55
}

/** `ipfs://<cid>[/<path>]` to gateway path-style URLs (`/ipfs/<cid>/<path>`).
 * `?format=raw` rides ONLY on bare raw-block CIDs — see {@link isRawBlockCid}. */
function resolveIpfs(uri: string): ResolvedTransport {
  // Tolerate `ipfs://ipfs/<cid>` and bare `ipfs://<cid>`.
  let rest = uri.slice('ipfs://'.length)
  if (rest.startsWith('ipfs/')) rest = rest.slice('ipfs/'.length)
  const slash = rest.indexOf('/')
  const cid = slash === -1 ? rest : rest.slice(0, slash)
  const subpath = slash === -1 ? '' : rest.slice(slash) // includes leading '/'
  if (cid.length === 0) {
    throw new UnsupportedUriError(uri, 'missing CID')
  }
  // CIDs are alphanumeric (base32/base58/base16); reject anything else so a
  // crafted CID can't smuggle path/host characters into the gateway URL.
  // STRUCTURAL CID validation deliberately lives in the WRITE preflight
  // (`validateMirrorUri` → {@link cidStructureError}), not here: reads stay as
  // tolerant as the gateways themselves, so a mirror that some gateway would
  // actually serve is never refused by our parser — the same read-tolerant /
  // write-strict split as `web3://` (r3742105028).
  if (!/^[A-Za-z0-9]+$/.test(cid)) {
    throw new UnsupportedUriError(uri, 'invalid CID')
  }
  return {
    scheme: TRANSPORT.ipfs,
    uri,
    httpUrls: (opts) => {
      const gateways = opts?.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS
      return gateways.map((g) => {
        const u = buildGatewayUrl(g, `ipfs/${cid}`, subpath, uri)
        // IPIP-402: ask for the verifiable raw block — but ONLY when the block
        // is the content itself. A subpath is a UnixFS directory walk whose
        // result is a file, never the root block, so it never qualifies
        // (r3742636236). We re-hash whatever comes back regardless.
        if (subpath === '' && isRawBlockCid(cid) && !u.searchParams.has('format')) {
          u.searchParams.set('format', 'raw')
        }
        return u
      })
    },
  }
}

/** `ar://<txid>[/<path>]` to arweave gateway URLs. */
function resolveArweave(uri: string): ResolvedTransport {
  const prefix = uri.toLowerCase().startsWith('arweave://') ? 'arweave://' : 'ar://'
  const rest = uri.slice(prefix.length)
  const slash = rest.indexOf('/')
  const txid = slash === -1 ? rest : rest.slice(0, slash)
  const subpath = slash === -1 ? '' : rest.slice(slash)
  if (txid.length === 0) {
    throw new UnsupportedUriError(uri, 'missing Arweave transaction id')
  }
  // Arweave tx ids are exactly 43 base64url chars (base64url of a 32-byte hash).
  // Require the exact length, not just the charset, so a short word like
  // `ar://graphql` is rejected instead of resolving to a gateway root path.
  if (!/^[A-Za-z0-9_-]{43}$/.test(txid)) {
    throw new UnsupportedUriError(
      uri,
      'invalid Arweave transaction id (expected 43 base64url chars)',
    )
  }
  // 43 base64url chars carry 258 bits, but the id is a 32-byte (256-bit) hash —
  // so the LAST character's low 2 bits are padding and must be zero, i.e. its
  // alphabet index is a multiple of 4 (r3742824658). Without this the length +
  // alphabet screen accepted a non-canonical spelling that strict base64url and
  // Arweave parsers reject, and `fs.write` could confirm it as an only mirror.
  if (B64URL_ALPHABET.indexOf(txid[42] as string) % 4 !== 0) {
    throw new UnsupportedUriError(
      uri,
      'non-canonical Arweave transaction id (the final character carries non-zero padding bits)',
    )
  }
  return {
    scheme: TRANSPORT.arweave,
    uri,
    httpUrls: (opts) => {
      const gateways = opts?.arweaveGateways ?? DEFAULT_ARWEAVE_GATEWAYS
      return gateways.map((g) => buildGatewayUrl(g, txid, subpath, uri))
    },
  }
}

/**
 * `data:[<mediatype>][;base64],<data>` (RFC 2397) to inline decoded bytes.
 * No network. The media type is captured for information only.
 */
function resolveData(uri: string, maxBytes?: number): ResolvedTransport {
  const comma = uri.indexOf(',')
  if (comma === -1) {
    throw new UnsupportedUriError(uri, 'malformed data: URI (no comma)')
  }
  // Trim the media type BEFORE the `;base64` test (WHATWG strips leading/trailing
  // whitespace first): `data:...;base64 ,…` is still base64, not literal text.
  const meta = uri.slice('data:'.length, comma).trim()
  const dataPart = uri.slice(comma + 1)
  const isBase64 = /;base64$/i.test(meta)
  const mediaType = (isBase64 ? meta.replace(/;base64$/i, '') : meta).trim()
  const contentType = mediaType.length > 0 ? mediaType : undefined

  let bytes: Uint8Array
  if (isBase64) {
    // base64 decodes whole (atob allocates the lot, and the WHATWG processor
    // percent-decodes the body first — `%2F`→`/`, `%3D`→`=`). Estimate the decoded
    // size from the RAW body via a scan (percent escapes decoded inline, whitespace
    // + trailing `=` padding excluded) and reject BEFORE materializing the decoded
    // base64 text, so an oversized percent-encoded body can't force the decode-all
    // allocation the cap exists to prevent.
    if (maxBytes !== undefined) {
      // Two bounds, BOTH checked before materializing the decoded string:
      //  1) significant (non-whitespace, non-padding) base64 chars → decoded bytes.
      //  2) the RAW percent-decoded length. A body that is mostly percent-encoded
      //     filler (e.g. `%20` repeated far past the cap) has sig===0 yet would still
      //     force `decodeURIComponent` to allocate the whole raw string. Bound the
      //     raw length too: to decode to ≤ maxBytes bytes a body needs ≤ ceil(maxBytes/3)*4
      //     significant chars; we allow a generous whitespace allowance on top of that,
      //     then reject — so the giant-filler payload is rejected by the cap, not
      //     materialized first. The scan decodes `%XX` inline (counting 1 char each)
      //     without building the string, so it is itself O(len) time / O(1) space.
      const sig = significantBase64Chars(dataPart)
      if (Math.floor((sig * 3) / 4) > maxBytes) {
        throw new UnsupportedUriError(uri, `inline payload exceeds maxBytes (~>${maxBytes})`)
      }
      // Budget: the base64 chars needed for maxBytes, plus the same again as a
      // whitespace/filler allowance (1 byte/char min). A larger raw body can only be
      // filler — reject it rather than percent-decode + allocate it.
      const rawCap = Math.ceil(maxBytes / 3) * 4 + maxBytes + 64
      if (percentDecodedLength(dataPart, rawCap + 1) > rawCap) {
        throw new UnsupportedUriError(uri, `inline payload exceeds maxBytes (~>${maxBytes})`)
      }
    }
    // WHATWG order: percent-decode the body, then base64-decode. Escapes are ASCII
    // (valid UTF-8); fall back to raw on malformed input.
    let b64Text = dataPart
    try {
      b64Text = decodeURIComponent(dataPart)
    } catch {
      // leave raw; decodeBase64's normalization/`atob` will surface the error
    }
    bytes = decodeBase64(b64Text)
  } else {
    bytes = decodeDataOctets(dataPart, uri, maxBytes)
  }

  // Authoritative cap on ACTUAL UTF-8 bytes (e.g. `€` is 1 char but 3 bytes, so a
  // char-count check under-counts). Enforced here so `resolveTransport` honors the
  // cap even when called directly, not only via fetchVerified afterward.
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new UnsupportedUriError(
      uri,
      `inline payload ${bytes.byteLength} bytes exceeds maxBytes (${maxBytes})`,
    )
  }

  return {
    scheme: TRANSPORT.data,
    uri,
    httpUrls: () => [],
    ...(contentType !== undefined ? { inline: { contentType, bytes } } : { inline: { bytes } }),
  }
}

/**
 * Decode a non-base64 `data:` payload to raw bytes (RFC 2397). Percent escapes
 * are OCTETS, not UTF-8 text — `%ff` is the byte `0xFF`, which `decodeURIComponent`
 * would reject as invalid UTF-8. So decode `%XX` byte-wise and emit literal runs
 * as their UTF-8 bytes. Never throws on arbitrary octets, so binary inline
 * mirrors (e.g. `data:application/octet-stream,%ff`) hash correctly.
 *
 * Bound-aware: aborts the moment the decoded length exceeds `maxBytes` (literals
 * are flushed in chunks so the running total is checked continuously), so a giant
 * literal payload can't allocate ~3× the cap before an after-the-fact check —
 * the size guard is enforced DURING decode, not after.
 */
function decodeDataOctets(s: string, uri: string, maxBytes?: number): Uint8Array {
  const cap = maxBytes ?? Number.POSITIVE_INFINITY
  const out: number[] = []
  const enc = new TextEncoder()
  let literal = ''
  const checkCap = () => {
    if (out.length > cap) {
      throw new UnsupportedUriError(uri, `inline payload exceeds maxBytes (${maxBytes})`)
    }
  }
  const flush = () => {
    if (literal.length > 0) {
      for (const b of enc.encode(literal)) out.push(b)
      literal = ''
      checkCap()
    }
  }
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '%' && i + 2 < s.length && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      flush()
      out.push(Number.parseInt(s.slice(i + 1, i + 3), 16))
      checkCap()
      i += 2
    } else {
      literal += s[i]
      // Flush in chunks to bound the running total + encode transient — but never
      // split a surrogate pair across the boundary (a lone high surrogate would
      // UTF-8-encode to the replacement char), so hold a trailing high surrogate
      // back for the next chunk.
      if (literal.length >= 4096) {
        const lastCode = literal.charCodeAt(literal.length - 1)
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
          const hold = literal.slice(-1)
          literal = literal.slice(0, -1)
          flush()
          literal = hold
        } else {
          flush()
        }
      }
    }
  }
  flush()
  return Uint8Array.from(out)
}

/**
 * Count the significant base64 characters of a (possibly percent-encoded) body
 * WITHOUT materializing the decoded string — percent escapes are decoded inline,
 * whitespace is skipped, and trailing `=` padding is excluded (counting padding
 * would over-estimate and falsely reject an at-cap payload). Used to size-check a
 * base64 `data:` body before allocating it. `floor(result * 3 / 4)` = decoded bytes.
 */
function significantBase64Chars(s: string): number {
  let sig = 0
  let pendingPad = 0 // `=` runs are padding only if nothing significant follows
  for (let i = 0; i < s.length; i += 1) {
    let ch = s[i] ?? ''
    if (ch === '%' && i + 2 < s.length && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      ch = String.fromCharCode(Number.parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      continue
    }
    if (ch === '=') {
      pendingPad += 1
      continue
    }
    sig += 1 + pendingPad // a real char means any prior `=` were not trailing padding
    pendingPad = 0
  }
  return sig
}

/**
 * Count the length of the percent-DECODED form of `s` WITHOUT materializing it —
 * each `%XX` escape counts as one character, every other char as itself. Used to
 * bound the raw size of a base64 `data:` body before `decodeURIComponent` allocates
 * it, so a payload that is mostly percent-encoded filler is rejected by the cap
 * instead of being fully decoded first. Stops early once the running count exceeds
 * `limit` (it never needs to look further to know the bound is breached).
 */
function percentDecodedLength(s: string, limit: number): number {
  let n = 0
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '%' && i + 2 < s.length && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      i += 2
    }
    n += 1
    if (n > limit) return n
  }
  return n
}

/** Decode a base64 string to bytes without Buffer (works in browser + node). */
function decodeBase64(b64: string): Uint8Array {
  // Tolerate URL-safe alphabet and stray whitespace/newlines.
  const normalized = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (typeof atob === 'function') {
    const bin = atob(normalized)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  // Node fallback (Buffer is global there; avoids a runtime dependency).
  const g = globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }
  if (g.Buffer) return Uint8Array.from(g.Buffer.from(normalized, 'base64'))
  throw new UnsupportedUriError('data:', 'no base64 decoder available in this runtime')
}
