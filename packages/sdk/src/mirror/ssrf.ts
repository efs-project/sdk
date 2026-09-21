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

/**
 * Expand an IPv6 textual address (lowercased, no brackets/zone) to its 16 bytes.
 * Handles `::` compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 * Returns `undefined` if it isn't a parseable IPv6 literal. Working at the byte
 * level (rather than string-prefix matching) collapses every textual variant —
 * compressed, expanded, mixed-case, leading-zero — to one canonical check.
 */
function expandIpv6(addr: string): number[] | undefined {
  if (!addr.includes(':')) return undefined
  let s = addr
  // A trailing embedded IPv4 (`…:1.2.3.4`) becomes two hextets.
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail)
    if (!v4) return undefined
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tailGroups = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null
  let groups: string[]
  if (tailGroups === null) {
    groups = head // no `::` — must be a full 8 groups
  } else {
    const missing = 8 - head.length - tailGroups.length
    if (missing < 0) return undefined
    groups = [...head, ...Array<string>(missing).fill('0'), ...tailGroups]
  }
  if (groups.length !== 8) return undefined
  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined
    const n = Number.parseInt(g, 16)
    bytes.push((n >> 8) & 0xff, n & 0xff)
  }
  return bytes
}

/**
 * A reason string for IPv6 addresses that must never be fetched server-side.
 * Beyond the literal scoped ranges, IPv6 can *embed* an IPv4 via several
 * transition prefixes (IPv4-mapped/-compatible/-translated, NAT64, 6to4) — each
 * a known SSRF bypass if only `::ffff:` is recognized — so we expand to bytes,
 * pull the embedded IPv4 out of every such prefix, and re-check it as IPv4.
 */
function isBlockedIpv6(addr: string): string | undefined {
  const b = expandIpv6(addr.toLowerCase())
  if (!b) {
    if (addr === '::1') return 'loopback (::1)'
    if (addr === '::') return 'unspecified (::)'
    return undefined
  }
  const at = (i: number) => b[i] ?? 0 // b is length 16; coalesce keeps the type clean
  const isZero = (lo: number, hi: number) => b.slice(lo, hi).every((x) => x === 0)

  if (isZero(0, 15) && at(15) === 1) return 'loopback (::1)'
  if (isZero(0, 16)) return 'unspecified (::)'
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return 'link-local (fe80::/10)'
  if ((at(0) & 0xfe) === 0xfc) return 'unique-local (fc00::/7)'
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0xc0) return 'site-local (fec0::/10, deprecated)'
  if (at(0) === 0xff) return 'multicast (ff00::/8)' // parity with the IPv4 >=224 block
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00)
    return 'Teredo (2001::/32)'

  // Transition prefixes that embed an IPv4 in their low bits — extract + recheck.
  let v4: [number, number, number, number] | undefined
  const low = (): [number, number, number, number] => [at(12), at(13), at(14), at(15)]
  if (isZero(0, 10) && at(10) === 0xff && at(11) === 0xff)
    v4 = low() // ::ffff:0:0/96 IPv4-mapped
  else if (isZero(0, 12))
    v4 = low() // ::/96 IPv4-compatible (:: and ::1 handled above)
  else if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b && isZero(4, 12))
    v4 = low() // 64:ff9b::/96 NAT64 well-known
  else if (isZero(0, 8) && at(8) === 0xff && at(9) === 0xff && isZero(10, 12))
    v4 = low() // ::ffff:0:0 IPv4-translated form
  else if (at(0) === 0x20 && at(1) === 0x02) v4 = [at(2), at(3), at(4), at(5)] // 2002::/16 6to4 (embedded v4 in bytes 2-5)
  if (v4) {
    const why = isBlockedIpv4(v4[0], v4[1], v4[2], v4[3])
    if (why) return `IPv6-embedded IPv4 ${why}`
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
  // Strip any trailing dot(s): DNS treats `localhost.` as the same host as
  // `localhost`, but `URL.hostname` preserves the dot, so the FQDN form would
  // otherwise slip past the literal name/IP checks below (P1).
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')

  if (opts.allowPrivateHosts) return { blocked: false }
  if (opts.allowlist?.some((h) => h.toLowerCase().replace(/\.+$/, '') === host)) {
    return { blocked: false }
  }

  // Literal IPv4.
  const v4 = parseIpv4(host)
  if (v4) {
    const why = isBlockedIpv4(v4[0], v4[1], v4[2], v4[3])
    if (why) return { blocked: true, host, reason: why }
    return { blocked: false }
  }

  // Literal IPv6.
  const v6 = normalizeIpv6(host)
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
