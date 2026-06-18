import { describe, expect, it, vi } from 'vitest'
import { hashContent } from '../src/content/hash.js'
import {
  AllMirrorsFailedError,
  DEFAULT_ARWEAVE_GATEWAYS,
  DEFAULT_IPFS_GATEWAYS,
  TRANSPORT,
  TransportNotImplementedError,
  UnsupportedUriError,
  checkSsrf,
  fetchVerified,
  resolveTransport,
} from '../src/mirror/index.js'

const enc = (s: string) => new TextEncoder().encode(s)

/** Build a minimal `Response`-like object with a streaming body so the engine's
 * capped reader path is exercised (not just arrayBuffer). */
function mockResponse(
  bytes: Uint8Array,
  init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('content-length')) headers.set('content-length', String(bytes.byteLength))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? 'OK',
    headers,
    body,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

describe('resolveTransport - URI parsing (TRANSPORT allowlist)', () => {
  it('parses https:// to itself', () => {
    const r = resolveTransport('https://example.com/file.bin')
    expect(r.scheme).toBe(TRANSPORT.https)
    expect(r.httpUrls().map((u) => u.href)).toEqual(['https://example.com/file.bin'])
  })

  it('parses ipfs://CID to the default gateway list with ?format=raw', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    const r = resolveTransport(`ipfs://${cid}`)
    expect(r.scheme).toBe(TRANSPORT.ipfs)
    const urls = r.httpUrls()
    expect(urls).toHaveLength(DEFAULT_IPFS_GATEWAYS.length)
    expect(urls[0]!.href).toBe(`https://ipfs.io/ipfs/${cid}?format=raw`)
    expect(urls[1]!.href).toBe(`https://dweb.link/ipfs/${cid}?format=raw`)
  })

  it('honors overridden ipfs gateways and a subpath', () => {
    const cid = 'bafytest'
    const r = resolveTransport(`ipfs://${cid}/dir/a.txt`)
    const urls = r.httpUrls({ ipfsGateways: ['https://my.gw/'] })
    expect(urls).toHaveLength(1)
    expect(urls[0]!.href).toBe(`https://my.gw/ipfs/${cid}/dir/a.txt?format=raw`)
  })

  it('rejects path traversal in ipfs/arweave subpaths (literal and %2e-encoded)', () => {
    const cid = 'bafytest'
    // Literal `..` and percent-encoded `%2e%2e` both normalize in new URL and
    // must not escape the /ipfs/<cid>/ namespace onto an arbitrary gateway path.
    expect(() => resolveTransport(`ipfs://${cid}/../admin`).httpUrls()).toThrow()
    expect(() => resolveTransport(`ipfs://${cid}/%2e%2e/admin`).httpUrls()).toThrow()
    expect(() => resolveTransport('ar://txid123/../../admin').httpUrls()).toThrow()
    // Sibling whose name shares the CID prefix: /ipfs/bafyadmin must NOT pass a
    // namespace check for /ipfs/bafy (needs a `/` boundary, not a raw prefix).
    expect(() => resolveTransport('ipfs://bafy/../bafyadmin').httpUrls()).toThrow()
    // A CID/txid that carries non-alphanumeric smuggling chars is rejected at parse.
    expect(() => resolveTransport('ipfs://bafy%2f..%2fadmin')).toThrow()
  })

  it('parses ar://TXID to arweave gateways', () => {
    const tx = 'AbC123_txid'
    const r = resolveTransport(`ar://${tx}`)
    expect(r.scheme).toBe(TRANSPORT.arweave)
    const urls = r.httpUrls()
    expect(urls).toHaveLength(DEFAULT_ARWEAVE_GATEWAYS.length)
    expect(urls[0]!.href).toBe(`https://arweave.net/${tx}`)
  })

  it('decodes a base64 data: URI inline (no network)', () => {
    // base64 of "hello"
    const r = resolveTransport('data:text/plain;base64,aGVsbG8=')
    expect(r.scheme).toBe(TRANSPORT.data)
    expect(r.inline?.contentType).toBe('text/plain')
    expect(new TextDecoder().decode(r.inline!.bytes)).toBe('hello')
    expect(r.httpUrls()).toEqual([])
  })

  it('decodes a percent-encoded (non-base64) data: URI inline', () => {
    const r = resolveTransport('data:,hello%20world')
    expect(new TextDecoder().decode(r.inline!.bytes)).toBe('hello world')
    expect(r.inline?.contentType).toBeUndefined()
  })

  it('rejects an oversized percent-encoded base64 body before materializing it', () => {
    // '%41' x1000 percent-decodes to 1000 'A's -> ~750 decoded bytes; at a small
    // cap it must be rejected from the raw-scan estimate, before decodeURIComponent.
    const body = '%41'.repeat(1000)
    expect(() => resolveTransport(`data:;base64,${body}`, { maxBytes: 64 })).toThrow()
  })

  it('detects ;base64 with whitespace before the comma (trimmed media type)', () => {
    // RFC 2397 allows whitespace; `;base64 ,` must still be treated as base64.
    const r = resolveTransport('data:text/plain;base64 ,SGVsbG8=')
    expect(new TextDecoder().decode(r.inline!.bytes)).toBe('Hello')
  })

  it('does not split a surrogate pair across the literal flush boundary', () => {
    // An astral char (😀 = F0 9F 98 80) landing on the 4096-char flush boundary
    // must encode as 4 bytes, not two replacement chars.
    const r = resolveTransport(`data:,${'a'.repeat(4095)}😀`)
    const tail = r.inline!.bytes.slice(-4)
    expect(Array.from(tail)).toEqual([0xf0, 0x9f, 0x98, 0x80])
  })

  it('percent-decodes a base64 data: body before decoding (WHATWG order)', () => {
    // %2Fw%3D%3D percent-decodes to '/w==', which base64-decodes to the byte 0xff.
    const r = resolveTransport('data:application/octet-stream;base64,%2Fw%3D%3D')
    expect(r.inline?.bytes).toEqual(new Uint8Array([0xff]))
    // And it must not be falsely rejected at a tight cap (1 real byte).
    const capped = resolveTransport('data:application/octet-stream;base64,%2Fw%3D%3D', {
      maxBytes: 1,
    })
    expect(capped.inline?.bytes).toEqual(new Uint8Array([0xff]))
  })

  it('decodes percent-escaped binary octets (not UTF-8 text) in data: URIs', () => {
    // %ff is the byte 0xFF — invalid UTF-8; decodeURIComponent would throw.
    const r = resolveTransport('data:application/octet-stream,%ff')
    expect(r.inline?.bytes).toEqual(new Uint8Array([0xff]))
    // Mixed literal + octet escapes round-trip byte-wise.
    const mixed = resolveTransport('data:,A%00%ff')
    expect(mixed.inline?.bytes).toEqual(new Uint8Array([0x41, 0x00, 0xff]))
  })

  it('magnet: parses but yields no HTTP URLs', () => {
    const r = resolveTransport('magnet:?xt=urn:btih:abc')
    expect(r.scheme).toBe(TRANSPORT.magnet)
    expect(r.httpUrls()).toEqual([])
  })

  it('web3:// parses but throws NotImplemented when resolved (the seam)', () => {
    const r = resolveTransport('web3://0xabc/foo')
    expect(r.scheme).toBe(TRANSPORT.web3)
    expect(() => r.httpUrls()).toThrow(TransportNotImplementedError)
  })

  it('rejects unknown schemes and schemeless input', () => {
    expect(() => resolveTransport('ftp://x')).toThrow(UnsupportedUriError)
    expect(() => resolveTransport('not-a-uri')).toThrow(UnsupportedUriError)
  })
})

describe('checkSsrf - host guard', () => {
  const block = (h: string) => checkSsrf(new URL(h))
  it('blocks loopback, private, link-local, metadata IPs', () => {
    expect(block('http://127.0.0.1/x').blocked).toBe(true)
    expect(block('http://10.0.0.5/x').blocked).toBe(true)
    expect(block('http://172.16.0.1/x').blocked).toBe(true)
    expect(block('http://192.168.1.1/x').blocked).toBe(true)
    expect(block('http://169.254.169.254/latest/meta-data').blocked).toBe(true)
    expect(block('http://[::1]/x').blocked).toBe(true)
    expect(block('http://localhost/x').blocked).toBe(true)
    expect(block('http://metadata.google.internal/x').blocked).toBe(true)
  })
  it('blocks IPv4-mapped IPv6, including the canonical hex form Node emits', () => {
    // new URL() canonicalizes [::ffff:127.0.0.1] -> hostname '::ffff:7f00:1';
    // both the dotted input and the explicit hex form must be blocked (P1 SSRF).
    expect(block('http://[::ffff:127.0.0.1]/x').blocked).toBe(true)
    expect(block('http://[::ffff:7f00:1]/x').blocked).toBe(true)
    expect(block('http://[::ffff:a9fe:a9fe]/latest/meta-data').blocked).toBe(true) // 169.254.169.254
    expect(block('http://[::ffff:0a00:0005]/x').blocked).toBe(true) // 10.0.0.5
    // A public IPv4-mapped address stays allowed.
    expect(block('http://[::ffff:0808:0808]/x').blocked).toBe(false) // 8.8.8.8
  })
  it('relies on URL normalization for alternate IPv4 encodings (lock-in)', () => {
    // Node's WHATWG URL parser canonicalizes these to dotted-quad BEFORE the
    // guard runs. These assertions lock that assumption in — if a future parser
    // stopped normalizing, the guard would silently weaken and this would fail.
    expect(block('http://0177.0.0.1/x').blocked).toBe(true) // octal -> 127.0.0.1
    expect(block('http://2130706433/x').blocked).toBe(true) // dword -> 127.0.0.1
    expect(block('http://0x7f000001/x').blocked).toBe(true) // hex -> 127.0.0.1
    expect(block('http://127.1/x').blocked).toBe(true) // part-collapse -> 127.0.0.1
    expect(block('http://2852039166/x').blocked).toBe(true) // dword -> 169.254.169.254
  })
  it('blocks IPv6 transition forms that embed a private/loopback IPv4', () => {
    expect(block('http://[::127.0.0.1]/x').blocked).toBe(true) // IPv4-compatible
    expect(block('http://[::ffff:0:127.0.0.1]/x').blocked).toBe(true) // IPv4-translated
    expect(block('http://[64:ff9b::127.0.0.1]/x').blocked).toBe(true) // NAT64 -> loopback
    expect(block('http://[64:ff9b::a9fe:a9fe]/x').blocked).toBe(true) // NAT64 -> metadata
    expect(block('http://[2002:7f00:1::]/x').blocked).toBe(true) // 6to4 -> 127.0.0.1
    expect(block('http://[fec0::1]/x').blocked).toBe(true) // site-local (deprecated)
    expect(block('http://[2001::1]/x').blocked).toBe(true) // Teredo
    // Public IPv6 and a public IPv4-mapped address stay allowed.
    expect(block('https://[2606:4700:4700::1111]/x').blocked).toBe(false) // Cloudflare DNS
    expect(block('http://[::ffff:8.8.8.8]/x').blocked).toBe(false)
  })
  it('blocks trailing-dot FQDN forms of internal hosts', () => {
    // DNS treats `localhost.` as `localhost`, but URL.hostname keeps the dot.
    expect(block('http://localhost./x').blocked).toBe(true)
    expect(block('http://metadata.google.internal./x').blocked).toBe(true)
    expect(block('http://foo.internal./x').blocked).toBe(true)
    expect(block('http://127.0.0.1./x').blocked).toBe(true)
  })
  it('allows public hosts', () => {
    expect(block('https://example.com/x').blocked).toBe(false)
    expect(block('https://8.8.8.8/x').blocked).toBe(false)
  })
  it('respects allowPrivateHosts + allowlist', () => {
    expect(checkSsrf(new URL('http://127.0.0.1/x'), { allowPrivateHosts: true }).blocked).toBe(
      false,
    )
    expect(checkSsrf(new URL('http://localhost/x'), { allowlist: ['localhost'] }).blocked).toBe(
      false,
    )
  })
})

describe('fetchVerified - happy paths per transport', () => {
  it('https happy path returns matches-author + declared content-type (informational)', async () => {
    const bytes = enc('the bytes')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn(async () =>
      mockResponse(bytes, { headers: { 'content-type': 'application/pdf' } }),
    ) as unknown as typeof fetch
    const res = await fetchVerified(['https://cdn.example.com/a'], hash, { fetchImpl })
    expect(res.verification).toBe('matches-author')
    expect(res.contentType).toBe('application/pdf')
    expect(res.mirrorUsed).toBe('https://cdn.example.com/a')
    expect(res.bytes).toEqual(bytes)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('ipfs happy path hits the first gateway', async () => {
    const bytes = enc('ipfs content')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn(async () => mockResponse(bytes)) as unknown as typeof fetch
    const res = await fetchVerified(['ipfs://bafytest'], hash, { fetchImpl })
    expect(res.verification).toBe('matches-author')
    expect(res.urlUsed).toBe('https://ipfs.io/ipfs/bafytest?format=raw')
  })

  it('data: URI is verified inline without any fetch call', async () => {
    const bytes = enc('hello')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const res = await fetchVerified(['data:text/plain;base64,aGVsbG8='], hash, { fetchImpl })
    expect(res.verification).toBe('matches-author')
    expect(res.contentType).toBe('text/plain')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a compressed response before reading the body (decompression bomb)', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse(enc('x'), { headers: { 'content-encoding': 'gzip' } }),
    ) as unknown as typeof fetch
    await expect(
      fetchVerified(['https://mirror.example/blob'], undefined, { fetchImpl }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
  })

  it('enforces maxBytes on inline data: URIs (no cap bypass)', async () => {
    // 'hello' is 5 bytes; cap at 4 -> the inline mirror must be rejected.
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      fetchVerified(['data:text/plain;base64,aGVsbG8='], undefined, { fetchImpl, maxBytes: 4 }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not count base64 padding/whitespace against the cap', async () => {
    // 'aGVsbG8=' decodes to exactly 5 bytes; at maxBytes=5 it must be ACCEPTED
    // (the padding `=` must not be counted as a 6th byte by the pre-check).
    const bytes = enc('hello')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const res = await fetchVerified(['data:text/plain;base64,aGVsbG8='], hash, {
      fetchImpl,
      maxBytes: 5,
    })
    expect(res.verification).toBe('matches-author')
    expect(res.bytes).toEqual(bytes)
  })

  it('elides the data: payload from error + attempt records (no full-payload copies)', async () => {
    const body = 'A'.repeat(5000)
    const uri = `data:;base64,${body}`
    await expect(fetchVerified([uri], undefined, { maxBytes: 64 })).rejects.toMatchObject({
      name: 'AllMirrorsFailedError',
    })
    try {
      await fetchVerified([uri], undefined, { maxBytes: 64 })
    } catch (e) {
      const err = e as AllMirrorsFailedError
      expect(err.attempts[0]!.uri).toContain('elided')
      expect(err.attempts[0]!.uri).not.toContain(body)
      expect(err.message).not.toContain(body)
    }
  })

  it('aborts a large literal data: payload during decode (bound-aware)', () => {
    // A mostly-literal payload well over the cap must be rejected by the decoder
    // itself, not allocated in full and then rejected after the fact.
    const big = 'a'.repeat(10_000)
    expect(() => resolveTransport(`data:,${big}`, { maxBytes: 64 })).toThrow()
  })

  it('counts UTF-8 bytes (not UTF-16 length) for text data: URIs', async () => {
    // '€' is 1 string char but 3 UTF-8 bytes; cap at 2 must reject it even though
    // its character count (1) is within the cap.
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      fetchVerified(['data:,%E2%82%AC'], undefined, { fetchImpl, maxBytes: 2 }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
    // resolveTransport enforces the cap directly too (not only via fetchVerified).
    expect(() => resolveTransport('data:,%E2%82%AC', { maxBytes: 2 })).toThrow()
    // A literal (non-percent-encoded) non-ASCII char is caught as well.
    expect(() => resolveTransport('data:,€', { maxBytes: 2 })).toThrow()
  })
})

describe('fetchVerified - failover', () => {
  it('falls over to the next ipfs gateway when the first errors', async () => {
    const bytes = enc('content')
    const hash = hashContent(bytes)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(new Uint8Array(), { status: 502, statusText: 'Bad Gateway' }),
      )
      .mockResolvedValueOnce(mockResponse(bytes)) as unknown as typeof fetch
    const res = await fetchVerified(['ipfs://bafytest'], hash, { fetchImpl })
    expect(res.verification).toBe('matches-author')
    expect(res.urlUsed).toBe('https://dweb.link/ipfs/bafytest?format=raw')
    expect(res.attempts).toHaveLength(1)
    expect(res.attempts[0]!.reason).toContain('502')
  })

  it('falls over from a dead mirror to the next mirror', async () => {
    const bytes = enc('second mirror wins')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const href = String(input)
      if (href.startsWith('https://dead.example')) throw new Error('ECONNREFUSED')
      return mockResponse(bytes)
    }) as unknown as typeof fetch
    const res = await fetchVerified(['https://dead.example/a', 'https://live.example/a'], hash, {
      fetchImpl,
    })
    expect(res.mirrorUsed).toBe('https://live.example/a')
    expect(res.attempts).toHaveLength(1)
  })

  it('web3:// mirror is recorded as failed but a later mirror still wins', async () => {
    const bytes = enc('x')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn(async () => mockResponse(bytes)) as unknown as typeof fetch
    const res = await fetchVerified(['web3://0xabc/f', 'https://ok.example/f'], hash, { fetchImpl })
    expect(res.mirrorUsed).toBe('https://ok.example/f')
    expect(res.attempts[0]!.scheme).toBe(TRANSPORT.web3)
    expect(res.attempts[0]!.reason).toContain('not implemented')
  })

  it('throws AllMirrorsFailedError with the attempt log when nothing works', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(
      fetchVerified(['https://a.example/x', 'https://b.example/x'], undefined, { fetchImpl }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
  })
})

describe('fetchVerified - size cap', () => {
  it('trips on an honest Content-Length over the cap (no body read)', async () => {
    const big = enc('x'.repeat(100))
    const fetchImpl = vi.fn(async () =>
      mockResponse(big, { headers: { 'content-length': '999999999' } }),
    ) as unknown as typeof fetch
    await expect(
      fetchVerified(['https://a.example/big'], undefined, { fetchImpl, maxBytes: 10 }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
  })

  it('trips while streaming when the declared length lies', async () => {
    const big = enc('x'.repeat(100))
    // Declare a small length but stream a large body.
    const fetchImpl = vi.fn(async () =>
      mockResponse(big, { headers: { 'content-length': '5' } }),
    ) as unknown as typeof fetch
    await expect(
      fetchVerified(['https://a.example/big'], undefined, { fetchImpl, maxBytes: 10 }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
  })
})

describe('fetchVerified - timeout', () => {
  it('aborts a slow attempt and fails over', async () => {
    vi.useFakeTimers()
    try {
      const bytes = enc('fast')
      const hash = hashContent(bytes)
      const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const href = String(input)
        if (href.includes('slow')) {
          // Never resolves on its own; rejects when the engine's timer aborts.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('aborted')
              e.name = 'AbortError'
              reject(e)
            })
          })
        }
        return Promise.resolve(mockResponse(bytes))
      }) as unknown as typeof fetch

      const p = fetchVerified(['https://slow.example/a', 'https://fast.example/a'], hash, {
        fetchImpl,
        timeoutMs: 1000,
      })
      // Advance past the per-attempt timeout so the slow attempt aborts.
      await vi.advanceTimersByTimeAsync(1001)
      const res = await p
      expect(res.mirrorUsed).toBe('https://fast.example/a')
      expect(res.attempts[0]!.reason).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fetchVerified - verification statuses', () => {
  const bytes = enc('payload')
  const makeFetch = () => vi.fn(async () => mockResponse(bytes)) as unknown as typeof fetch

  it('mismatch when the hash diverges', async () => {
    const res = await fetchVerified(['https://a.example/x'], hashContent(enc('other')), {
      fetchImpl: makeFetch(),
    })
    expect(res.verification).toBe('mismatch')
    expect(res.bytes).toEqual(bytes) // bytes are still returned
  })

  it('malformed-claim when expectedHash is not 64-hex', async () => {
    const res = await fetchVerified(['https://a.example/x'], '0xdeadbeef', {
      fetchImpl: makeFetch(),
    })
    expect(res.verification).toBe('malformed-claim')
  })

  it('no-claim when expectedHash is undefined', async () => {
    const res = await fetchVerified(['https://a.example/x'], undefined, {
      fetchImpl: makeFetch(),
    })
    expect(res.verification).toBe('no-claim')
  })
})

describe('fetchVerified - SSRF', () => {
  it('skips an SSRF-blocked host and records it, then fails over', async () => {
    const bytes = enc('safe')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn(async () => mockResponse(bytes)) as unknown as typeof fetch
    const res = await fetchVerified(
      ['https://169.254.169.254/latest', 'https://public.example/x'],
      hash,
      { fetchImpl },
    )
    expect(res.mirrorUsed).toBe('https://public.example/x')
    expect(res.attempts[0]!.reason).toContain('SSRF-blocked')
    // The blocked host was never fetched.
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith('https://public.example/x', expect.anything())
  })

  it('allows a private host when allowPrivateHosts is set', async () => {
    const bytes = enc('local')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn(async () => mockResponse(bytes)) as unknown as typeof fetch
    const res = await fetchVerified(['https://127.0.0.1/x'], hash, {
      fetchImpl,
      allowPrivateHosts: true,
    })
    expect(res.verification).toBe('matches-author')
  })

  it('re-checks redirect targets: a 30x to a private host is blocked (P1)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      // A public mirror that tries to bounce us at loopback.
      if (url === 'https://public.example/a') {
        return mockResponse(new Uint8Array(), {
          status: 302,
          headers: { location: 'http://127.0.0.1/secret' },
        })
      }
      throw new Error(`unexpected fetch to ${url}`) // 127.0.0.1 must never be hit
    }) as unknown as typeof fetch
    await expect(
      fetchVerified(['https://public.example/a'], undefined, { fetchImpl }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
    // The redirect was issued once; the loopback target was never fetched.
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith('https://public.example/a', expect.anything())
  })

  it('follows a redirect to a public host and verifies the final bytes', async () => {
    const bytes = enc('after redirect')
    const hash = hashContent(bytes)
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://public.example/a'
        ? mockResponse(new Uint8Array(), {
            status: 302,
            headers: { location: 'https://cdn.example/b' },
          })
        : mockResponse(bytes),
    ) as unknown as typeof fetch
    const res = await fetchVerified(['https://public.example/a'], hash, { fetchImpl })
    expect(res.verification).toBe('matches-author')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenLastCalledWith('https://cdn.example/b', expect.anything())
  })
})

describe('fetchVerified - AbortSignal', () => {
  it('an already-aborted signal short-circuits before any fetch', async () => {
    const ac = new AbortController()
    ac.abort()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      fetchVerified(['https://a.example/x'], undefined, { fetchImpl, signal: ac.signal }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not decode an inline data: mirror when already aborted', async () => {
    // The abort check must run BEFORE resolveTransport decodes the inline payload.
    const ac = new AbortController()
    ac.abort()
    await expect(
      fetchVerified(['data:text/plain;base64,aGVsbG8='], undefined, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(AllMirrorsFailedError)
  })
})
