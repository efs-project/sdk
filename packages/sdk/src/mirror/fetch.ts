/**
 * fetchVerified - the off-chain fetch/verify/mirror engine. Given an ordered
 * list of mirror URIs and an attested `contentHash`, try each transport and
 * gateway in order with a per-attempt timeout and sequential failover, read the
 * full bytes under a hard size cap, hash them, and report a trust-relative
 * `VerificationStatus`. Freeze-independent: nothing here touches attestations.
 *
 * Security doctrine (future-proofing.md §2/§4):
 *   - Verify before trust: hash the full bytes against `contentHash`; a CID or a
 *     gateway's word is never trusted (CID is not sha256, ADR-0006).
 *   - nosniff: NEVER decide handling from the response `Content-Type`. We return
 *     the declared type as informational only and never execute fetched bytes.
 *   - Hard size cap: stream and abort past the cap to defend against zip-bombs
 *     and error-page poisoning (an HTML 404 body would otherwise hash-mismatch
 *     silently after a large download).
 *   - SSRF guard: block private/loopback/link-local/metadata hosts (Node is
 *     where it bites; the browser guards itself).
 *   - AbortSignal: the caller can cancel the whole operation.
 */

import { type ContentHash, type VerificationStatus, hashContent } from '../content/hash.js'
import type { TransportName } from '../types.js'
import { type SsrfGuardOptions, checkSsrf } from './ssrf.js'
import { type ResolveOptions, type ResolvedTransport, resolveTransport } from './transport.js'

/** Default per-attempt timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 10_000
/** Default hard size cap (bytes) ~50 MB. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

/** A mirror to try: a bare URI or an object carrying one. */
export type Mirror = string | { uri: string }

function mirrorUri(m: Mirror): string {
  return typeof m === 'string' ? m : m.uri
}

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

/** A 64-hex bare SHA-256 (an unbranded shape `expectedHash` may arrive as). */
function isWellFormedHash(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s.toLowerCase())
}

/** Compute the trust-relative status without re-importing verifyContent's
 * branching (we already have the bytes hashed once on the success path). */
function statusFor(bytes: Uint8Array, expectedHash: string | undefined): VerificationStatus {
  if (expectedHash === undefined) return 'no-claim'
  const claim = expectedHash.toLowerCase()
  if (!isWellFormedHash(claim)) return 'malformed-claim'
  return (hashContent(bytes) as string) === claim ? 'matches-author' : 'mismatch'
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
    // No stream (e.g. some mock environments) - fall back to arrayBuffer, still
    // enforcing the cap after the fact.
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      throw new Error(`body size ${buf.byteLength} exceeds cap ${maxBytes}`)
    }
    return buf
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

/** Try a single concrete HTTP(S) URL. Returns bytes + declared type, or throws. */
async function fetchOne(
  url: URL,
  opts: FetchVerifiedOptions,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
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
    const res = await doFetch(url.href, {
      signal: controller.signal,
      redirect: 'follow',
      // We never want a cached cross-origin opaque response; ask for bytes.
      headers: { accept: 'application/octet-stream, */*' },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    const bytes = await readCapped(res, maxBytes, controller)
    // Content-Type is informational ONLY (nosniff). We capture the declared
    // value but never branch handling on it and never execute the bytes.
    const declaredType = res.headers.get('content-type') ?? undefined
    return declaredType !== undefined ? { bytes, contentType: declaredType } : { bytes }
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
 * `data:` URIs short-circuit to their inline bytes (no network). `web3://`
 * throws NotImplemented when its (lazy) `httpUrls` is read - recorded as a
 * failed attempt so a later mirror can still win.
 *
 * @throws {AllMirrorsFailedError} if no mirror yielded bytes.
 */
export async function fetchVerified(
  mirrors: readonly Mirror[],
  expectedHash: ContentHash | string | undefined,
  opts: FetchVerifiedOptions = {},
): Promise<FetchVerifiedResult> {
  const attempts: AttemptError[] = []

  for (const mirror of mirrors) {
    const uri = mirrorUri(mirror)
    let resolved: ResolvedTransport
    try {
      resolved = resolveTransport(uri)
    } catch (err) {
      attempts.push({ uri, scheme: 'https', reason: errMsg(err) })
      continue
    }

    // Inline data: - no network, no SSRF, just decode + verify.
    if (resolved.inline) {
      const bytes = resolved.inline.bytes
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

    // Expand to candidate URLs (may throw for web3:// - the clear seam).
    let urls: URL[]
    try {
      urls = resolved.httpUrls(opts)
    } catch (err) {
      attempts.push({ uri, scheme: resolved.scheme, reason: errMsg(err) })
      continue
    }
    if (urls.length === 0) {
      attempts.push({
        uri,
        scheme: resolved.scheme,
        reason: `transport "${resolved.scheme}" has no HTTP resolution path`,
      })
      continue
    }

    for (const url of urls) {
      // SSRF guard before any network call.
      const ssrf = checkSsrf(url, opts)
      if (ssrf.blocked) {
        attempts.push({
          uri,
          url: url.href,
          scheme: resolved.scheme,
          reason: `SSRF-blocked host (${ssrf.reason})`,
        })
        continue
      }

      // Cooperative cancellation between attempts.
      if (opts.signal?.aborted) {
        attempts.push({
          uri,
          url: url.href,
          scheme: resolved.scheme,
          reason: 'aborted by caller',
        })
        throw new AllMirrorsFailedError(attempts)
      }

      try {
        const { bytes, contentType } = await fetchOne(url, opts)
        const verification = statusFor(bytes, expectedHash)
        return {
          bytes,
          verification,
          ...(contentType !== undefined ? { contentType } : {}),
          mirrorUsed: uri,
          urlUsed: url.href,
          attempts,
        }
      } catch (err) {
        attempts.push({
          uri,
          url: url.href,
          scheme: resolved.scheme,
          reason: errMsg(err),
        })
        // Sequential failover - try the next gateway / mirror.
      }
    }
  }

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
