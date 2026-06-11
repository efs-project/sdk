/**
 * Mirror layer - the off-chain fetch/verify/mirror engine. Freeze-independent:
 * given (uri, expectedHash) it yields verified bytes; nothing here touches
 * attestations. See future-proofing.md §2 ("the mirror doctrine").
 *
 * Public surface:
 *   - `TRANSPORT` allowlist + `resolveTransport(uri)` URI parsing.
 *   - `fetchVerified(mirrors, expectedHash, opts?)` - sequential failover,
 *     per-attempt timeout, hard size cap, nosniff, SSRF guard, AbortSignal.
 *   - `checkSsrf(url, opts?)` - the standalone SSRF host guard.
 */

export {
  TRANSPORT,
  resolveTransport,
  DEFAULT_IPFS_GATEWAYS,
  DEFAULT_ARWEAVE_GATEWAYS,
  TransportNotImplementedError,
  UnsupportedUriError,
  type ResolveOptions,
  type ResolvedTransport,
  type InlineData,
} from './transport.js'

export {
  fetchVerified,
  AllMirrorsFailedError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  type Mirror,
  type FetchVerifiedOptions,
  type FetchVerifiedResult,
  type AttemptError,
} from './fetch.js'

export {
  checkSsrf,
  type SsrfGuardOptions,
  type SsrfResult,
  type SsrfOk,
  type SsrfRejection,
} from './ssrf.js'
