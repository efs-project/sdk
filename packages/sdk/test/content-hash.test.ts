import { describe, expect, it } from 'vitest'
import {
  asContentHash,
  decodeContentHash,
  hashContent,
  verifyContent,
} from '../src/content/hash.js'

const enc = (s: string) => new TextEncoder().encode(s)

// ── contracts specs/10 §7 conformance vectors (spec-quoted, byte-exact) ──────
// An SDK author and a Solidity verifier MUST produce byte-identical values.
const VECTORS = [
  {
    name: 'empty content ("")',
    bytes: new Uint8Array(),
    sha2: 'f1220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    keccakB16: 'f1b20c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    keccakB32: 'bdmqmlusgagdpoiz4sj7h3mw4y4b4bziawzj4varhhn57vwaelwc2i4a',
  },
  {
    name: 'abc',
    bytes: enc('abc'),
    sha2: 'f1220ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    keccakB16: 'f1b204e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    keccakB32: 'bdmqe4a3fplvelkkpy7khxkbgzdlgpqgr43rtuzfag3wej5mpuewwyri',
  },
  {
    name: 'hello\\n',
    bytes: enc('hello\n'),
    sha2: 'f12205891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
    keccakB16: 'f1b201d63660020a5b5062fb35d9f82afa81581442281c43343763ab1d340e9861bae',
    keccakB32: 'bdmqb2y3gaaqklnigf6zv3h4cv6ublakeeka4im2doy5ldu2a5gdbxlq',
  },
] as const

describe('contentHash codec (specs/10 + SDK ADR-0016: multibase-multihash)', () => {
  it('emits the canonical f1220… sha2-256 form for every spec §7 vector', () => {
    for (const v of VECTORS) {
      expect(hashContent(v.bytes), v.name).toBe(v.sha2)
    }
  })

  it('canonical shape: f1220 + 64 lowercase hex = 69 chars', () => {
    const h = hashContent(enc('hello'))
    expect(h).toMatch(/^f1220[0-9a-f]{64}$/)
    expect(h).toHaveLength(69)
  })

  it('verifies trust-relative: matches-author / mismatch / no-claim', () => {
    const bytes = enc('gm')
    expect(verifyContent(bytes, hashContent(bytes))).toBe('matches-author')
    expect(verifyContent(bytes, hashContent(enc('other')))).toBe('mismatch')
    expect(verifyContent(bytes, undefined)).toBe('no-claim')
  })

  it('verifies the keccak-256 base16 alternate (f1b20…) at digest level', () => {
    // A keccak claim names its own function via the multihash code — the
    // verifier dispatches on it (specs/10 §6), so the alternate verifies.
    for (const v of VECTORS) {
      expect(verifyContent(v.bytes, v.keccakB16), v.name).toBe('matches-author')
    }
    // …and against the WRONG bytes it is a mismatch, not malformed.
    expect(verifyContent(enc('not abc'), VECTORS[1].keccakB16)).toBe('mismatch')
  })

  it('accepts b/base32 claims on read (RFC 4648 lowercase, no padding)', () => {
    for (const v of VECTORS) {
      expect(verifyContent(v.bytes, v.keccakB32), v.name).toBe('matches-author')
    }
    // Derived sha2 b-form round-trip: encode digest → b-form → decode → canonical.
    const decodedKeccak = decodeContentHash(VECTORS[0].keccakB32)
    expect(decodedKeccak?.algorithm).toBe('keccak-256')
    expect(decodedKeccak?.canonical).toBe(VECTORS[0].keccakB16)
  })

  it('flags every non-conforming claim as malformed-claim, never a pass (A9)', () => {
    const bytes = enc('gm')
    const bareSha2 = (hashContent(bytes) as string).slice(5) // strip f1220 → bare digest
    // The superseded ADR-0006 bare form is algorithm-ambiguous (specs/10 §1).
    expect(verifyContent(bytes, bareSha2)).toBe('malformed-claim')
    // The debug-UI legacy 0x-prefixed form.
    expect(verifyContent(bytes, `0x${bareSha2}`)).toBe('malformed-claim')
    // Uppercase/mixed multibase or hex — multibase `f` is base16-LOWER only.
    expect(verifyContent(bytes, (hashContent(bytes) as string).toUpperCase())).toBe(
      'malformed-claim',
    )
    expect(verifyContent(bytes, `f1220${bareSha2.toUpperCase()}`)).toBe('malformed-claim')
    // Truncated digest.
    expect(verifyContent(bytes, `f1220${bareSha2.slice(0, 63)}`)).toBe('malformed-claim')
    // Unregistered multihash code (blake3 0x1e) — closed registry at genesis.
    expect(verifyContent(bytes, `f1e20${bareSha2}`)).toBe('malformed-claim')
    // Wrong length byte.
    expect(verifyContent(bytes, `f1221${bareSha2}`)).toBe('malformed-claim')
    // A CIDv1 in the contentHash slot: valid base32, but its leading
    // version/codec bytes are not a registered bare-multihash header.
    expect(
      verifyContent(bytes, 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'),
    ).toBe('malformed-claim')
    expect(verifyContent(bytes, 'deadbeef')).toBe('malformed-claim')
    expect(verifyContent(bytes, '')).toBe('malformed-claim')
  })

  it('decodeContentHash: accepted forms decode; canonical re-encoding is stable', () => {
    const h = hashContent(enc('abc'))
    const d = decodeContentHash(h)
    expect(d?.algorithm).toBe('sha2-256')
    expect(d?.digest).toHaveLength(32)
    expect(d?.canonical).toBe(h)
    // Rejects: bare, 0x, padding, uppercase, unregistered, non-multibase.
    expect(decodeContentHash((h as string).slice(5))).toBeUndefined()
    expect(decodeContentHash(`0x${(h as string).slice(5)}`)).toBeUndefined()
    expect(decodeContentHash('b')).toBeUndefined()
    expect(decodeContentHash('')).toBeUndefined()
    expect(decodeContentHash(`${VECTORS[0].keccakB32}=`)).toBeUndefined()
  })

  it('asContentHash: canonical base16 forms only', () => {
    const sha2 = hashContent(enc('x')) as string
    expect(asContentHash(sha2)).toBe(sha2)
    expect(asContentHash(VECTORS[0].keccakB16)).toBe(VECTORS[0].keccakB16)
    // Not canonical: bare digest, b-form, 0x form, uppercase.
    expect(asContentHash(sha2.slice(5))).toBeUndefined()
    expect(asContentHash(VECTORS[0].keccakB32)).toBeUndefined()
    expect(asContentHash(`0x${sha2.slice(5)}`)).toBeUndefined()
    expect(asContentHash(sha2.toUpperCase())).toBeUndefined()
  })
})
