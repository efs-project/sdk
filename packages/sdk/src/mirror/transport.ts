/**
 * Transport resolution — parse a mirror URI into the concrete HTTP(S) URLs the
 * fetch engine will try. Freeze-independent: this layer has nothing to do with
 * attestations, only with *where the bytes live*.
 *
 * Doctrine (future-proofing.md §2, standards.md "Content addressing"):
 *   - `ipfs://`/`ar://`/`https://` ADOPT; `data:` SEAM (tiny inline content);
 *     `web3://` we own but resolution needs a chain + ERC-6944 → NotImplemented
 *     here (clear seam); `magnet://` parse-only (no HTTP resolution).
 *   - CID is a *locator only* — never trusted as `sha256(bytes)` (ADR-0006).
 *     We always re-verify fetched bytes against the attested `contentHash`.
 *   - Multi-gateway fallback: a transport can expand to several candidate URLs;
 *     the fetch engine tries them in order (public gateways die / rate-limit /
 *     turn hostile — assume any single one is unreliable).
 */

import type { TransportName } from '../types.js'

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

/** Default IPFS gateways, tried in order. Trustless-friendly: we request
 * `?format=raw` (IPIP-402) so a gateway returns the raw block bytes rather than
 * a UnixFS-unwrapped/transcoded representation — but note CID is not sha256
 * regardless, so the gateway is never trusted; the fetch engine re-hashes every
 * byte. Overridable via `ResolveOptions.ipfsGateways`. */
export const DEFAULT_IPFS_GATEWAYS: readonly string[] = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://cloudflare-ipfs.com',
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

/** Thrown when a URI cannot be parsed or its scheme is unrecognized. */
export class UnsupportedUriError extends Error {
  override readonly name = 'UnsupportedUriError'
  constructor(uri: string, detail: string) {
    super(`unsupported mirror URI "${uri}": ${detail}`)
  }
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

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
export function resolveTransport(uri: string, opts: { maxBytes?: number } = {}): ResolvedTransport {
  const scheme = SCHEME_RE.exec(uri)?.[1]?.toLowerCase()
  if (!scheme) {
    throw new UnsupportedUriError(uri, 'no URI scheme')
  }

  switch (scheme) {
    case 'https':
    case 'http': {
      // `http:` is accepted as a parse target but the SSRF/security guard in the
      // fetch engine governs whether it is actually allowed to be retrieved.
      let parsed: URL
      try {
        parsed = new URL(uri)
      } catch {
        throw new UnsupportedUriError(uri, 'malformed https URL')
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
      return resolveData(uri, opts.maxBytes)

    case 'magnet':
      // Parse-only: BitTorrent has no synchronous HTTP resolution path here.
      return {
        scheme: TRANSPORT.magnet,
        uri,
        httpUrls: () => [],
      }

    case 'web3':
      // Recognized, but resolution needs a chain client plus ERC-6944
      // (resolveMode == "5219") decoding — out of scope for the off-chain fetch
      // engine. The seam: a future web3 resolver yields the on-chain (status,
      // body, headers) which this engine would then treat like inline bytes.
      return {
        scheme: TRANSPORT.web3,
        uri,
        httpUrls: () => {
          throw new TransportNotImplementedError(
            TRANSPORT.web3,
            'needs a chain client and ERC-6944 resolveMode decoding',
          )
        },
      }

    default:
      throw new UnsupportedUriError(uri, `unrecognized scheme "${scheme}"`)
  }
}

/** `ipfs://<cid>[/<path>]` to gateway path-style URLs (`/ipfs/<cid>/<path>`),
 * each carrying `?format=raw` to prefer the raw block over a transcoded one. */
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
        // IPIP-402: ask the gateway for the verifiable raw block. Harmless on
        // gateways that ignore it; we re-hash regardless.
        if (!u.searchParams.has('format')) u.searchParams.set('format', 'raw')
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
  // Arweave tx ids are base64url (43 chars of [A-Za-z0-9_-]); reject anything
  // else so the id can't carry path/host characters.
  if (!/^[A-Za-z0-9_-]+$/.test(txid)) {
    throw new UnsupportedUriError(uri, 'invalid Arweave transaction id')
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
  const meta = uri.slice('data:'.length, comma)
  const dataPart = uri.slice(comma + 1)
  const isBase64 = /;base64$/i.test(meta)
  const mediaType = (isBase64 ? meta.replace(/;base64$/i, '') : meta).trim()
  const contentType = mediaType.length > 0 ? mediaType : undefined

  // For a base64 payload the WHATWG data: processor percent-decodes the body
  // BEFORE base64-decoding, so producers may percent-encode base64 specials
  // (`%2F`→`/`, `%2B`→`+`, `%3D`→`=`). Decode to the real base64 text first so the
  // size estimate and `atob` see actual base64 chars, not `%XX` triplets. Percent
  // escapes here are ASCII (valid UTF-8); fall back to raw on malformed input.
  let b64Text = dataPart
  if (isBase64) {
    try {
      b64Text = decodeURIComponent(dataPart)
    } catch {
      // leave raw; decodeBase64's normalization/`atob` will surface the error
    }
  }

  // base64 decodes whole (atob allocates the lot), so reject up front on the
  // decoded-size estimate: `floor(sig*3/4)` over the significant chars (whitespace
  // and `=` padding stripped, since counting them over-estimates and would falsely
  // reject an at-cap payload like `aGVsbG8=` → 5 bytes, not 6). The text path needs
  // no pre-check — decodeDataOctets is bound-aware and aborts mid-decode.
  if (maxBytes !== undefined && isBase64) {
    const sig = b64Text.replace(/\s+/g, '').replace(/=+$/, '').length
    if (Math.floor((sig * 3) / 4) > maxBytes) {
      throw new UnsupportedUriError(uri, `inline payload exceeds maxBytes (~>${maxBytes})`)
    }
  }

  let bytes: Uint8Array
  if (isBase64) {
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
      if (literal.length >= 4096) flush() // bound the running total + encode transient
    }
  }
  flush()
  return Uint8Array.from(out)
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
