/**
 * SSRF guard - block fetches whose host resolves to a private, loopback,
 * link-local, or cloud-metadata address (future-proofing.md §2/§4: "untrusted
 * content is inert - SSRF-guard mirror URLs, block private/loopback/metadata
 * IPs").
 *
 * Where this bites: Node. A server-side process fetching an attacker-chosen
 * mirror URI can be steered at 169.254.169.254 (cloud metadata), 127.0.0.1
 * (local admin endpoints), or RFC-1918 LAN hosts. In a browser this is the
 * browser's job (it won't expose internal responses cross-origin), so this
 * guard is defense-in-depth there but always applied.
 *
 * Important limitation: this is a literal-IP and hostname-shape guard. It does
 * NOT perform DNS resolution, so a public hostname that resolves to a private
 * IP (DNS rebinding) is not caught here. That requires resolving + pinning at
 * connect time, which global fetch does not expose; documented as a known gap.
 */

/** Why a host was rejected. */
export type SsrfRejection = {
  blocked: true
  host: string
  reason: string
}
export type SsrfOk = { blocked: false }
export type SsrfResult = SsrfOk | SsrfRejection

/** Options for the SSRF guard. */
export type SsrfGuardOptions = {
  /**
   * Disable the guard entirely. Default `false`. Set `true` only when the
   * caller has its own egress controls (e.g. a locked-down proxy) or is in a
   * browser and wants to skip the redundant check.
   */
  allowPrivateHosts?: boolean
  /** Extra hostnames to allow even if they look private (exact, lowercased). */
  allowlist?: readonly string[]
}

// IPv4 dotted-quad.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function parseIpv4(host: string): [number, number, number, number] | undefined {
  const m = IPV4_RE.exec(host)
  if (!m) return undefined
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const
  if (octets.some((o) => o > 255)) return undefined
  return [octets[0], octets[1], octets[2], octets[3]]
}

/** A reason string for IPv4 ranges that must never be fetched server-side. */
function isBlockedIpv4(a: number, b: number, c: number, _d: number): string | undefined {
  if (a === 0) return 'unspecified/this-network (0.0.0.0/8)'
  if (a === 127) return 'loopback (127.0.0.0/8)'
  if (a === 10) return 'private (10.0.0.0/8)'
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16.0.0/12)'
  if (a === 192 && b === 168) return 'private (192.168.0.0/16)'
  if (a === 169 && b === 254) return 'link-local / cloud-metadata (169.254.0.0/16)'
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64.0.0/10)'
  if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments (192.0.0.0/24)'
  if (a >= 224) return 'multicast/reserved (>=224.0.0.0)'
  return undefined
}

/** Strip IPv6 brackets and zone id; return the lowercased address. */
function normalizeIpv6(host: string): string | undefined {
  if (!host.startsWith('[') || !host.endsWith(']')) {
    // Bare IPv6 (no brackets) only matters if it contains a colon.
    if (host.includes(':')) {
      const [addr] = host.split('%')
      return (addr ?? host).toLowerCase()
    }
    return undefined
  }
  const [addr] = host.slice(1, -1).split('%')
  return (addr ?? '').toLowerCase()
}

/** A reason string for IPv6 addresses that must never be fetched server-side. */
function isBlockedIpv6(addr: string): string | undefined {
  const a = addr.toLowerCase()
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return 'loopback (::1)'
  if (a === '::' || a === '0:0:0:0:0:0:0:0') return 'unspecified (::)'
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb'))
    return 'link-local (fe80::/10)'
  if (a.startsWith('fc') || a.startsWith('fd')) return 'unique-local (fc00::/7)'
  // IPv4-mapped (::ffff:a.b.c.d) - extract and re-check as IPv4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(a)
  if (mapped?.[1]) {
    const v4 = parseIpv4(mapped[1])
    if (v4) {
      const why = isBlockedIpv4(v4[0], v4[1], v4[2], v4[3])
      if (why) return `IPv4-mapped ${why}`
    }
  }
  return undefined
}

/**
 * Assess a URL's host for SSRF risk. Returns `{ blocked: false }` to allow, or
 * a rejection with a human-readable `reason`. Hostnames that aren't literal IPs
 * are allowed here (no DNS resolution) except for a small set of obviously
 * internal names (`localhost`, `*.local`, `*.internal`).
 */
export function checkSsrf(url: URL, opts: SsrfGuardOptions = {}): SsrfResult {
  const host = url.hostname.toLowerCase()

  if (opts.allowPrivateHosts) return { blocked: false }
  if (opts.allowlist?.some((h) => h.toLowerCase() === host)) return { blocked: false }

  // Literal IPv4.
  const v4 = parseIpv4(host)
  if (v4) {
    const why = isBlockedIpv4(v4[0], v4[1], v4[2], v4[3])
    if (why) return { blocked: true, host, reason: why }
    return { blocked: false }
  }

  // Literal IPv6.
  const v6 = normalizeIpv6(url.hostname)
  if (v6) {
    const why = isBlockedIpv6(v6)
    if (why) return { blocked: true, host: v6, reason: why }
    return { blocked: false }
  }

  // Obvious internal hostnames (no DNS resolution available to us).
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { blocked: true, host, reason: 'localhost' }
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    return { blocked: true, host, reason: 'internal TLD' }
  }
  // AWS/GCP/Azure metadata hostnames sometimes used in place of the IP.
  if (host === 'metadata.google.internal' || host === 'metadata') {
    return { blocked: true, host, reason: 'cloud metadata host' }
  }

  return { blocked: false }
}
