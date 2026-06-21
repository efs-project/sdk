/**
 * Unit tests for the `web3://` (SSTORE2) read transport (`mirror/web3.ts`) and its
 * wiring into the fetch engine (`mirror/fetch.ts`'s injected `web3Reader`).
 *
 * The read mirrors `EFSRouter.sol`'s `web3://` branch exactly: parse the
 * `web3://0x<40hex>` URI → chunk-manager address, `chunkCount()` then `chunkAddress(i)`
 * per chunk, `getCode(addr)` per chunk, strip the leading SSTORE2 `0x00` STOP byte,
 * concatenate. The mocked `publicClient` returns `chunkCount → 2`, two chunk addresses,
 * and `0x00 || chunkBytes` per chunk; the test asserts the concatenated bytes equal the
 * original (STOP byte stripped).
 */

import { type Address, ContractFunctionZeroDataError, type Hex, bytesToHex, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { hashContent } from '../src/content/hash.js'
import { fetchVerified } from '../src/mirror/fetch.js'
import {
  type Web3ReadClient,
  Web3ReadError,
  parseWeb3Uri,
  readWeb3Bytes,
} from '../src/mirror/web3.js'

const enc = (s: string) => new TextEncoder().encode(s)

const MANAGER = '0x00000000000000000000000000000000000a1234' as Address
const CHUNK_0 = '0x000000000000000000000000000000000000c0d0' as Address
const CHUNK_1 = '0x000000000000000000000000000000000000c0d1' as Address

/** Wrap content bytes in the SSTORE2 runtime convention: `0x00 || content` — exactly
 * what the write path's `buildSstore2InitCode` deploys and the router skips byte 0 of. */
function sstore2Code(content: Uint8Array): Hex {
  const runtime = new Uint8Array(content.byteLength + 1)
  runtime[0] = 0x00 // STOP byte
  runtime.set(content, 1)
  return bytesToHex(runtime)
}

/**
 * A mocked {@link Web3ReadClient}: `chunkCount` → number of chunks, `chunkAddress(i)`
 * → the i-th address, `getCode(addr)` → that chunk's `0x00`-prefixed runtime.
 */
function makeClient(chunks: { addr: Address; content: Uint8Array }[]): Web3ReadClient {
  const codeByAddr = new Map<string, Hex>(
    chunks.map((c) => [c.addr.toLowerCase(), sstore2Code(c.content)]),
  )
  return {
    async readContract(args) {
      if (args.functionName === 'chunkCount') return BigInt(chunks.length)
      if (args.functionName === 'chunkAddress') {
        const [i] = (args.args ?? []) as [bigint]
        return chunks[Number(i)]?.addr ?? '0x0000000000000000000000000000000000000000'
      }
      throw new Error(`unexpected ${args.functionName}`)
    },
    async getCode(args) {
      return codeByAddr.get(args.address.toLowerCase())
    },
  }
}

describe('parseWeb3Uri', () => {
  it('parses web3://0x<40hex> to the checksummed address', () => {
    expect(parseWeb3Uri(`web3://${MANAGER}`).toLowerCase()).toBe(MANAGER.toLowerCase())
  })

  it('accepts the 0X uppercase prefix (router parity)', () => {
    expect(parseWeb3Uri(`web3://0X${MANAGER.slice(2)}`).toLowerCase()).toBe(MANAGER.toLowerCase())
  })

  it('accepts a bare 40-hex (no 0x) and tolerates a trailing path', () => {
    const bare = MANAGER.slice(2)
    expect(parseWeb3Uri(`web3://${bare}`).toLowerCase()).toBe(MANAGER.toLowerCase())
    expect(parseWeb3Uri(`web3://${MANAGER}/some/path`).toLowerCase()).toBe(MANAGER.toLowerCase())
  })

  it('throws Web3ReadError on a non-web3 scheme or a too-short / non-hex address', () => {
    expect(() => parseWeb3Uri('https://x')).toThrow(Web3ReadError)
    expect(() => parseWeb3Uri('web3://0x1234')).toThrow(Web3ReadError)
    expect(() => parseWeb3Uri(`web3://0x${'z'.repeat(40)}`)).toThrow(Web3ReadError)
  })

  it('accepts a router-valid mixed-case address with NO valid EIP-55 checksum', () => {
    // The router parses the address case-insensitively, so a mirror from another client
    // may carry arbitrary mixed-case hex. Build a variant with every alpha case flipped
    // vs the canonical checksum — guaranteed-invalid EIP-55 (the address has letters).
    // The old code passed it verbatim to getAddress and threw; we must accept it.
    const lower = `0x${'da7a'.repeat(10)}` as Address
    const canonical = getAddress(lower)
    const badChecksum = `0x${canonical
      .slice(2)
      .split('')
      .map((c) =>
        c >= 'a' && c <= 'f' ? c.toUpperCase() : c >= 'A' && c <= 'F' ? c.toLowerCase() : c,
      )
      .join('')}`
    expect(badChecksum).not.toBe(canonical) // genuinely a wrong checksum
    expect(() => parseWeb3Uri(`web3://${badChecksum}`)).not.toThrow()
    expect(parseWeb3Uri(`web3://${badChecksum}`)).toBe(canonical) // normalized back
  })
})

describe('readWeb3Bytes (matches EFSRouter web3:// read)', () => {
  it('concatenates two chunks with the STOP byte stripped', async () => {
    const part0 = enc('hello, ')
    const part1 = enc('on-chain world')
    const client = makeClient([
      { addr: CHUNK_0, content: part0 },
      { addr: CHUNK_1, content: part1 },
    ])

    const bytes = await readWeb3Bytes(`web3://${MANAGER}`, client)

    const expected = new Uint8Array([...part0, ...part1])
    expect(bytes).toEqual(expected)
    // The STOP byte is stripped: the first byte is 'h', not 0x00.
    expect(bytes[0]).toBe(part0[0])
  })

  it('reads a single chunk back exactly', async () => {
    const content = enc('single chunk payload ✅')
    const client = makeClient([{ addr: CHUNK_0, content }])
    const bytes = await readWeb3Bytes(`web3://${MANAGER}`, client)
    expect(bytes).toEqual(content)
  })

  it('throws when a chunk contract has no code (router HTTP 500 parity)', async () => {
    const client: Web3ReadClient = {
      async readContract(args) {
        if (args.functionName === 'chunkCount') return 1n
        return CHUNK_0
      },
      async getCode() {
        return '0x'
      },
    }
    await expect(readWeb3Bytes(`web3://${MANAGER}`, client)).rejects.toBeInstanceOf(Web3ReadError)
  })

  it('throws when the manager reports zero chunks', async () => {
    const client = makeClient([])
    await expect(readWeb3Bytes(`web3://${MANAGER}`, client)).rejects.toBeInstanceOf(Web3ReadError)
  })

  it('falls back to a RAW SSTORE2 target when chunkCount() is absent (router parity)', async () => {
    // A web3:// mirror may point directly at a single raw SSTORE2 contract (older store /
    // another client) with no chunkCount(). The router treats the failed staticcall as
    // "not chunked" and reads the target's own code; we must too, not fail the read.
    const content = enc('raw single-contract SSTORE2 payload')
    // A raw SSTORE2 contract returns 0x for chunkCount() → viem ContractFunctionZeroDataError.
    const zeroData = new ContractFunctionZeroDataError({ functionName: 'chunkCount' })
    const client: Web3ReadClient = {
      async readContract(args) {
        if (args.functionName === 'chunkCount') throw zeroData
        throw new Error(`unexpected ${args.functionName}`)
      },
      async getCode(args) {
        // The TARGET's own runtime is `0x00 || content` (raw SSTORE2), read directly.
        return args.address.toLowerCase() === MANAGER.toLowerCase()
          ? sstore2Code(content)
          : undefined
      },
    }
    const bytes = await readWeb3Bytes(`web3://${MANAGER}`, client)
    expect(bytes).toEqual(content) // STOP byte stripped, content returned
  })

  it('surfaces a no-code raw target as Web3ReadError (router HTTP 500 parity)', async () => {
    const zeroData = new ContractFunctionZeroDataError({ functionName: 'chunkCount' })
    const client: Web3ReadClient = {
      async readContract(args) {
        if (args.functionName === 'chunkCount') throw zeroData
        throw new Error('unexpected')
      },
      async getCode() {
        return '0x'
      },
    }
    await expect(readWeb3Bytes(`web3://${MANAGER}`, client)).rejects.toBeInstanceOf(Web3ReadError)
  })

  it('does NOT raw-fall-back on a transport/RPC error (real manager — try the next mirror)', async () => {
    // A timeout/connection error on a genuine chunk manager must NOT be mistaken for a raw
    // store: returning the manager's own bytecode as content would be garbage and skip
    // later mirrors. It propagates as a Web3ReadError (a failed attempt) — getCode is
    // never even consulted (the manager IS a chunk manager).
    let getCodeCalled = false
    const client: Web3ReadClient = {
      async readContract(args) {
        if (args.functionName === 'chunkCount') throw new Error('HTTP request failed: ETIMEDOUT')
        throw new Error('unexpected')
      },
      async getCode() {
        getCodeCalled = true
        return sstore2Code(enc('manager bytecode — must NOT be returned'))
      },
    }
    await expect(readWeb3Bytes(`web3://${MANAGER}`, client)).rejects.toBeInstanceOf(Web3ReadError)
    expect(getCodeCalled).toBe(false)
  })

  it('stops early when the running total exceeds maxBytes (no full-payload read)', async () => {
    const ten = enc('0123456789') // 10 content bytes per chunk
    let chunksRead = 0
    const code = new Map<string, Hex>([
      [CHUNK_0.toLowerCase(), sstore2Code(ten)],
      [CHUNK_1.toLowerCase(), sstore2Code(ten)],
    ])
    const client: Web3ReadClient = {
      async readContract(args) {
        if (args.functionName === 'chunkCount') return 3n // claims 3 chunks
        if (args.functionName === 'chunkAddress') {
          const [i] = (args.args ?? []) as [bigint]
          return [CHUNK_0, CHUNK_1, CHUNK_0][Number(i)] as Address
        }
        throw new Error(`unexpected ${args.functionName}`)
      },
      async getCode(args) {
        chunksRead += 1
        return code.get(args.address.toLowerCase())
      },
    }
    // cap 15: chunk 0 (10, ok) → chunk 1 (total 20 > 15, trips) → throw before chunk 2.
    await expect(readWeb3Bytes(`web3://${MANAGER}`, client, 15)).rejects.toBeInstanceOf(
      Web3ReadError,
    )
    expect(chunksRead).toBe(2) // the 3rd chunk was never read/allocated
  })
})

describe('fetchVerified web3:// transport (engine integration)', () => {
  it('reads on-chain bytes via the injected web3Reader and verifies the hash', async () => {
    const content = enc('verified on-chain bytes')
    const hash = hashContent(content)
    const client = makeClient([{ addr: CHUNK_0, content }])

    const res = await fetchVerified([`web3://${MANAGER}`], hash, {
      web3Reader: (uri) => readWeb3Bytes(uri, client),
    })

    expect(res.bytes).toEqual(content)
    expect(res.verification).toBe('matches-author')
    expect(res.mirrorUsed).toBe(`web3://${MANAGER}`)
  })

  it('reports a mismatch when the on-chain bytes do not match the claimed hash', async () => {
    const client = makeClient([{ addr: CHUNK_0, content: enc('actual bytes') }])
    const wrongHash = hashContent(enc('different bytes'))
    const res = await fetchVerified([`web3://${MANAGER}`], wrongHash, {
      web3Reader: (uri) => readWeb3Bytes(uri, client),
    })
    expect(res.verification).toBe('mismatch')
  })

  it('without a web3Reader, web3:// is a failed attempt and a later mirror wins', async () => {
    const content = enc('fallback')
    const hash = hashContent(content)
    const fetchImpl: typeof fetch = async () =>
      new Response(content, { status: 200, headers: { 'content-length': String(content.length) } })
    const res = await fetchVerified([`web3://${MANAGER}`, 'https://ok.example/f'], hash, {
      fetchImpl,
    })
    expect(res.mirrorUsed).toBe('https://ok.example/f')
    expect(res.attempts[0]?.scheme).toBe('web3')
  })
})
