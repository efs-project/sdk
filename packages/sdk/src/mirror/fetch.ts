/**
 * fetchVerified - the off-chain fetch/verify/mirror engine. Given an ordered
 * list of mirror URIs and an attested `contentHash`, try each transport and
 * gateway in order with a per-attempt timeout and sequential failover, read the
 * full bytes under a hard size cap, hash them, and report a trust-relative
 * `VerificationStatus`. Freeze-independent: nothing here touches attestations.
 *
 * Security doctrine (future-proofing.md §2/§4):
 *   - Verify before trust: hash the full bytes against `contentHash`; a CID or a
 *     gateway's word is never trusted. (A raw CIDv1 shares the canonical sha2-256
 *     digest — specs/10 §4 — but dag-pb/chunked CIDs do not; the CID stays a
 *     locator, never a verification input, in this engine.)
 *   - nosniff: NEVER decide handling from the response `Content-Type`. We return
 *     the declared type as informational only and never execute fetched bytes.
 *   - Hard size cap: stream and abort past the cap to defend against zip-bombs
 *     and error-page poisoning (an HTML 404 body would otherwise hash-mismatch
 *     silently after a large download).
 *   - SSRF guard: block private/loopback/link-local/metadata hosts (Node is
 *     where it bites; the browser guards itself).
 *   - AbortSignal: the caller can cancel the whole operation.
 */

import { type ContentHash, type VerificationStatus, verifyContent } from '../content/hash.js'
import type { TransportName } from '../types.js'
import { type SsrfGuardOptions, checkSsrf } from './ssrf.js'
import {
  type ResolveOptions,
  type ResolvedTransport,
  TRANSPORT,
  resolveTransport,
  summarizeUri,
} from './transport.js'

/** Default per-attempt timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 10_000
/** The platform timer ceiling (2^31 − 1 ms ≈ 24.8 days): `setTimeout` with a
 * larger delay TRUNCATES to ~1 ms (Node emits TimeoutOverflowWarning), which
 * would abort every attempt immediately — so it is the validation bound. */
export const MAX_TIMEOUT_MS = 2_147_483_647
/** Default hard size cap (bytes) ~50 MB. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

/** A mirror to try: a bare URI or an object carrying one. */
export type Mirror = string | { uri: string }

function mirrorUri(m: Mirror): string {
  return typeof m === 'string' ? m : m.uri
}

/**
 * Resolve a `web3://` mirror URI to its on-chain (SSTORE2) bytes. Injected by the
 * read path (which threads its `publicClient` into {@link readWeb3Bytes}); the
 * mirror engine itself stays chain-free. Absent ⇒ `web3://` mirrors are recorded as
 * a failed attempt (the original NotImplemented seam), so a later mirror can win.
 */
export type Web3Reader = (
  uri: string,
  opts?: { maxBytes?: number; signal?: AbortSignal },
) => Promise<Uint8Array>

/** Options for {@link fetchVerified}. */
export type FetchVerifiedOptions = ResolveOptions &
  SsrfGuardOptions & {
    /** Per-attempt timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
    timeoutMs?: number
    /** Hard cap on bytes read per attempt (default {@link DEFAULT_MAX_BYTES}). */
    maxBytes?: number
    /** Caller cancellation for the whole operation. */
    signal?: AbortSignal
    /** Inject a `fetch` implementation (tests stub this). Defaults to global. */
    fetchImpl?: typeof fetch
    /**
     * Allow plaintext `http://` mirrors and `http://` redirect targets. Default
     * `false` — ADR-0010 names `https://` as the web transport, and an attacker-
     * authored mirror could otherwise downgrade retrieval to cleartext (bytes are
     * hash-checked, but availability/privacy/provenance are not). Set `true` only
     * when the caller trusts the source (e.g. a local dev mirror). */
    allowInsecureHttp?: boolean
    /** Resolve a `web3://` mirror to its on-chain bytes (see {@link Web3Reader}).
     * When provided, `web3://` mirrors become a real transport; when absent they
     * stay the NotImplemented seam (recorded as a failed attempt). */
    web3Reader?: Web3Reader
  }

/** One failed attempt, kept so callers can surface why every mirror failed. */
export type AttemptError = {
  uri: string
  url?: string
  scheme: TransportName
  reason: string
}

/** The result of a successful {@link fetchVerified}. */
export type FetchVerifiedResult = {
  /** The full verified bytes (whatever the hash status, these are the bytes). */
  bytes: Uint8Array
  /** Trust-relative status of the bytes against `expectedHash`. */
  verification: VerificationStatus
  /** The transport's declared media type - INFORMATIONAL ONLY (nosniff). */
  contentType?: string
  /** The mirror URI the bytes came from. */
  mirrorUsed: string
  /** The concrete URL fetched (absent for inline `data:`). */
  urlUsed?: string
  /** Every attempt that failed before success, in order. */
  attempts: readonly AttemptError[]
}

/** Thrown when every mirror/gateway attempt failed. Carries the attempt log. */
export class AllMirrorsFailedError extends Error {
  override readonly name = 'AllMirrorsFailedError'
  readonly attempts: readonly AttemptError[]
  constructor(attempts: readonly AttemptError[]) {
    const detail = attempts.map((a) => `${a.url ?? a.uri}: ${a.reason}`).join('; ')
    super(`all mirrors failed: ${detail || '(no mirrors provided)'}`)
    this.attempts = attempts
  }
}

/** Compute the trust-relative status of the bytes against the claim. ONE
 * decode/verify implementation lives in the contentHash codec (`verifyContent`,
 * specs/10 §6) — this engine deliberately does not re-implement claim parsing,
 * so the accepted-form rules (f/base16, b/base32, registered codes only,
 * digest-level compare) cannot drift between the read path and the engine. */
function statusFor(bytes: Uint8Array, expectedHash: string | undefined): VerificationStatus {
  return verifyContent(bytes, expectedHash)
}

/**
 * Read a `Response` body into bytes under a hard cap. Aborts (via the provided
 * controller) and throws if the declared or actual size exceeds `maxBytes`.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  abort: AbortController,
): Promise<Uint8Array> {
  // Early rejection on an honest Content-Length (cheap; not trusted for
  // handling, only as an upper-bound fast-path).
  const declared = res.headers.get('content-length')
  if (declared !== null) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      abort.abort()
      throw new Error(`declared size ${n} exceeds cap ${maxBytes}`)
    }
  }

  const body = res.body
  if (!body) {
    // No readable stream ⇒ the cap CANNOT be enforced during the read: an
    // `arrayBuffer()` fallback would buffer the ENTIRE (attacker-sized) body
    // before any check ran — Content-Length is attacker-controlled and may be
    // absent or understated, so a post-hoc check does not bound the
    // allocation. Fail the attempt (failover proceeds); every real fetch
    // (undici, browsers) exposes a stream — bodyless responses are
    // mock/polyfill territory, and a mock that wants this path must provide a
    // `body` stream like the real platform does.
    throw new Error('response body is not streamable — the size cap cannot be enforced')
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          abort.abort()
          throw new Error(`stream exceeded cap ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/**
 * Settle when `p` settles OR when `signal` aborts — whichever is first. The
 * underlying promise is NOT cancelled (an in-flight RPC without an abortable
 * transport keeps running, orphaned); the point is that the CALLER settles, so
 * a per-attempt timeout can force failover past a transport that never
 * resolves. The orphan's eventual rejection is swallowed (no unhandled
 * rejection).
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {}) // orphaned — swallow its eventual rejection
      reject(new DOMException('This operation was aborted', 'AbortError'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** Link an outer abort signal to an inner controller, once. */
function linkAbort(outer: AbortSignal | undefined, inner: AbortController): () => void {
  if (!outer) return () => {}
  if (outer.aborted) {
    inner.abort()
    return () => {}
  }
  const onAbort = () => inner.abort()
  outer.addEventListener('abort', onAbort, { once: true })
  return () => outer.removeEventListener('abort', onAbort)
}

/** Max redirect hops to follow before giving up (each re-checked for SSRF). */
const MAX_REDIRECTS = 5

/** Read the capped body and capture the declared (informational) content type. */
async function finishResponse(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  // Refuse compressed responses BEFORE reading the body. undici auto-inflates
  // gzip/br/zstd, so a tiny compressed body can balloon past maxBytes during the
  // read (and chained encodings were unbounded pre-undici-7.18.2, CVE-2026-22036).
  // Mirror bytes are raw and hash-verified, so transport compression is never
  // wanted; rejecting it here means the decompression stream is never pumped.
  const encoding = res.headers.get('content-encoding')
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new Error(`refusing compressed response (content-encoding: ${encoding})`)
  }
  const bytes = await readCapped(res, maxBytes, controller)
  // Content-Type is informational ONLY (nosniff): captured, never acted on.
  const declaredType = res.headers.get('content-type') ?? undefined
  return declaredType !== undefined ? { bytes, contentType: declaredType } : { bytes }
}

/** Try a single concrete HTTP(S) URL. Returns bytes + declared type + the FINAL
 * URL actually fetched (after any redirects), or throws. */
async function fetchOne(
  url: URL,
  opts: FetchVerifiedOptions,
): Promise<{ bytes: Uint8Array; contentType?: string; finalUrl: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new Error('no fetch implementation available (provide opts.fetchImpl)')
  }

  const controller = new AbortController()
  const unlink = linkAbort(opts.signal, controller)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let current = url
    for (let hop = 0; ; hop += 1) {
      // redirect: 'manual' is load-bearing security: a public mirror must not
      // be able to 30x us toward a private/metadata host without re-running the
      // SSRF guard on the new target (P1). In Node/undici this surfaces the 3xx
      // + Location; in a browser it yields an opaque redirect, where the browser
      // enforces SSRF/CORS itself, so we let it follow there.
      const res = await doFetch(current.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { accept: 'application/octet-stream, */*', 'accept-encoding': 'identity' },
      })

      if (res.type === 'opaqueredirect') {
        // Browser path: the redirect chain is OPAQUE — the destination cannot be
        // inspected, so none of the per-hop guards the Node path runs (SSRF
        // private-host check, http-downgrade check, hop cap) can be applied.
        // Following it "because the browser enforces safety" is NOT sound: CORS
        // gates response READING, not whether the redirected request REACHES a
        // private-network endpoint, and Private Network Access is not universal —
        // a malicious mirror could still aim requests at local services. Fail
        // this attempt closed; a non-redirecting mirror/gateway can still win.
        throw new Error(
          'opaque redirect (browser): destination cannot be safety-checked (SSRF/downgrade guards need the Location) — refusing to follow; use a direct (non-redirecting) gateway',
        )
      }

      if (res.status >= 300 && res.status < 400) {
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (> ${MAX_REDIRECTS})`)
        const location = res.headers.get('location')
        if (!location) throw new Error(`HTTP ${res.status} redirect with no Location`)
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          throw new Error(`invalid redirect Location: ${location}`)
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`redirect to non-http(s) scheme (${next.protocol})`)
        }
        // Same downgrade defense as resolveTransport: a redirect must not steer us
        // from https onto plaintext http unless the caller opted in. (We follow
        // redirects manually with redirect:'manual', so this hop-by-hop re-check is
        // authoritative in Node/undici.)
        if (next.protocol === 'http:' && opts.allowInsecureHttp !== true) {
          throw new Error('redirect to plaintext http:// (set allowInsecureHttp to opt in)')
        }
        const ssrf = checkSsrf(next, opts)
        if (ssrf.blocked) throw new Error(`redirect to SSRF-blocked host (${ssrf.reason})`)
        current = next
        continue
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      return { ...(await finishResponse(res, maxBytes, controller)), finalUrl: current.href }
    }
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

/**
 * Fetch bytes from the first reachable mirror/gateway and verify them against
 * `expectedHash`. Tries mirrors in order; within a mirror, tries each candidate
 * gateway URL in order; SSRF-blocked URLs are skipped (recorded as attempts).
 *
 * `data:` URIs short-circuit to their inline bytes (no network). `web3://` reads its
 * on-chain (SSTORE2) bytes via the injected `web3Reader` when one is provided;
 * without a reader it throws NotImplemented (recorded as a failed attempt so a later
 * mirror can still win).
 *
 * @throws {AllMirrorsFailedError} if no mirror yielded bytes.
 */
export async function fetchVerified(
  mirrors: readonly Mirror[],
  expectedHash: ContentHash | string | undefined,
  opts: FetchVerifiedOptions = {},
): Promise<FetchVerifiedResult> {
  // `fetchVerified` is public SDK surface, so a direct caller can pass a non-finite or
  // non-positive `maxBytes`. Every downstream cap check is a `>` comparison, so `NaN` never
  // rejects an oversized `data:`/HTTP/web3 payload and `Infinity` disables the hard ceiling.
  // Reject up front. (The higher-level `fetchRef` validates too — this keeps the engine safe
  // on its own.)
  if (opts.maxBytes !== undefined && (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0)) {
    throw new RangeError(
      `fetchVerified: \`maxBytes\` must be a finite positive number (got ${opts.maxBytes}). Omit it for the ${DEFAULT_MAX_BYTES}-byte default ceiling.`,
    )
  }
  // Same class (proactive sweep): a NaN timeout makes `setTimeout` fire
  // IMMEDIATELY (treated as 0), aborting every attempt before its first byte —
  // a confusing all-mirrors-failed instead of a config error.
  if (
    opts.timeoutMs !== undefined &&
    (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new RangeError(
      `fetchVerified: \`timeoutMs\` must be a positive number ≤ ${MAX_TIMEOUT_MS} (got ${opts.timeoutMs}) — platform timers truncate larger values to ~1 ms, which would abort every attempt immediately. Omit it for the ${DEFAULT_TIMEOUT_MS} ms default.`,
    )
  }
  const attempts: AttemptError[] = []

  for (const mirror of mirrors) {
    const uri = mirrorUri(mirror)
    // A short, safe form for error/attempt records — never copies a full (possibly
    // oversized) data: payload into an Error message or AllMirrorsFailedError.
    const safeUri = summarizeUri(uri)
    // Honor cancellation BEFORE resolving — resolveTransport decodes inline data:
    // payloads, so an already-aborted caller must not pay that allocation/hash.
    // The abort PROPAGATES as itself (throwIfAborted rethrows the caller's own
    // reason): converting it into AllMirrorsFailedError misclassified a user
    // cancellation as a mirror outage.
    opts.signal?.throwIfAborted()
    let resolved: ResolvedTransport
    try {
      resolved = resolveTransport(uri, {
        maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
        ...(opts.allowInsecureHttp !== undefined
          ? { allowInsecureHttp: opts.allowInsecureHttp }
          : {}),
      })
    } catch (err) {
      attempts.push({ uri: safeUri, scheme: 'https', reason: errMsg(err) })
      continue
    }

    // Inline data: - no network, no SSRF, just decode + verify. Still enforce
    // the size cap: a giant data: URI (from untrusted metadata) must not bypass
    // maxBytes just because no fetch is involved.
    if (resolved.inline) {
      const bytes = resolved.inline.bytes
      const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
      if (bytes.byteLength > maxBytes) {
        attempts.push({
          uri: safeUri,
          scheme: resolved.scheme,
          reason: `inline payload ${bytes.byteLength} bytes exceeds cap (${maxBytes})`,
        })
        continue
      }
      const verification = statusFor(bytes, expectedHash)
      return {
        bytes,
        verification,
        ...(resolved.inline.contentType !== undefined
          ? { contentType: resolved.inline.contentType }
          : {}),
        mirrorUsed: uri,
        attempts,
      }
    }

    // web3:// — read the on-chain (SSTORE2) bytes via the injected reader, when one
    // is provided. No network/SSRF: the bytes come off the chain client. Still cap
    // the size + verify like any mirror (the on-chain store is a locator, not the
    // hash). With no reader, fall through to httpUrls() → the NotImplemented seam.
    if (resolved.scheme === TRANSPORT.web3 && opts.web3Reader) {
      // Same cancellation envelope as an HTTP attempt: the caller's signal is
      // linked and the per-attempt timeout armed, so a stalled RPC or a hostile
      // manager's long chunk walk cannot block failover past `timeoutMs`, and
      // aborting the documented whole-operation signal actually stops the read.
      const controller = new AbortController()
      const unlink = linkAbort(opts.signal, controller)
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      try {
        const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
        // Thread the cap INTO the reader so it stops mid-walk (the bundled
        // readWeb3Bytes throws once the running total exceeds it) instead of
        // accumulating every chunk first. The post-check below stays as defense.
        // RACE the reader against the signal: the per-chunk signal checks inside
        // readWeb3Bytes only run BETWEEN RPCs — a single readContract/getCode
        // that never settles (a transport with no timeout of its own) would
        // otherwise hold this await open past the timer, blocking failover.
        const bytes = await raceAbort(
          opts.web3Reader(uri, { maxBytes, signal: controller.signal }),
          controller.signal,
        )
        if (bytes.byteLength > maxBytes) {
          attempts.push({
            uri: safeUri,
            scheme: resolved.scheme,
            reason: `on-chain payload ${bytes.byteLength} bytes exceeds cap (${maxBytes})`,
          })
          continue
        }
        const verification = statusFor(bytes, expectedHash)
        return { bytes, verification, mirrorUsed: uri, attempts }
      } catch (err) {
        attempts.push({ uri: safeUri, scheme: resolved.scheme, reason: errMsg(err) })
        continue
      } finally {
        clearTimeout(timer)
        unlink()
      }
    }

    // Expand to candidate URLs (may throw for web3:// - the clear seam).
    let urls: URL[]
    try {
      urls = resolved.httpUrls(opts)
    } catch (err) {
      attempts.push({ uri: safeUri, scheme: resolved.scheme, reason: errMsg(err) })
      continue
    }
    if (urls.length === 0) {
      attempts.push({
        uri: safeUri,
        scheme: resolved.scheme,
        reason: `transport "${resolved.scheme}" has no HTTP resolution path`,
      })
      continue
    }

    for (const url of urls) {
      // Plaintext-HTTP guard for EVERY concrete URL — not just direct http:// mirrors
      // and redirects. An `http://` IPFS/Arweave gateway (opts.ipfsGateways/arweaveGateways)
      // resolves to a plaintext URL here, so enforce the same downgrade check before the
      // network call unless explicitly opted in.
      if (url.protocol === 'http:' && opts.allowInsecureHttp !== true) {
        attempts.push({
          uri: safeUri,
          url: summarizeUri(url.href),
          scheme: resolved.scheme,
          reason: 'plaintext http URL (set allowInsecureHttp to permit)',
        })
        continue
      }

      // SSRF guard before any network call.
      const ssrf = checkSsrf(url, opts)
      if (ssrf.blocked) {
        attempts.push({
          uri: safeUri,
          url: summarizeUri(url.href),
          scheme: resolved.scheme,
          reason: `SSRF-blocked host (${ssrf.reason})`,
        })
        continue
      }

      // Cooperative cancellation between gateway attempts — propagated AS the
      // abort (the caller's own reason), same rule as the mirror loop: an
      // aborted first gateway must not surface as a mirror OUTAGE just because
      // the transport had another candidate URL.
      opts.signal?.throwIfAborted()

      try {
        const { bytes, contentType, finalUrl } = await fetchOne(url, opts)
        const verification = statusFor(bytes, expectedHash)
        return {
          bytes,
          verification,
          ...(contentType !== undefined ? { contentType } : {}),
          mirrorUsed: uri,
          urlUsed: finalUrl,
          attempts,
        }
      } catch (err) {
        attempts.push({
          uri: safeUri,
          url: summarizeUri(url.href),
          scheme: resolved.scheme,
          reason: errMsg(err),
        })
        // Sequential failover - try the next gateway / mirror.
      }
    }
  }

  // If the loop drained BECAUSE the caller aborted mid-attempt (the per-attempt
  // failure was logged and the loop advanced), the cancellation wins over the
  // mirror-outage framing.
  opts.signal?.throwIfAborted()
  throw new AllMirrorsFailedError(attempts)
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    // AbortError shows up as a timeout/cancel on this path.
    if (err.name === 'AbortError') return 'timed out or aborted'
    return err.message
  }
  return String(err)
}
