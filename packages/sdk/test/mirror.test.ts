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
})
