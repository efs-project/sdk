import { http, type Address, createPublicClient } from 'viem'
import { sepolia } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import { MaxLensesExceeded, NotImplemented, createEfsClient, identity, lens } from '../src/index.js'

const publicClient = createPublicClient({ chain: sepolia, transport: http() })
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

describe('namespaced client (Decision F)', () => {
  it('builds a client; unbuilt fs verbs throw NotImplemented', () => {
    const efs = createEfsClient({ publicClient })
    expect(() => efs.fs.write('/x', new Uint8Array())).toThrow(NotImplemented)
    expect(() => efs.fs.read('/x')).toThrow(NotImplemented)
    expect(() => efs.fs.list('/x')).toThrow(NotImplemented)
  })

  it('exposes lens helpers under efs.lenses', () => {
    const efs = createEfsClient({ publicClient })
    expect(typeof efs.lenses.lens).toBe('function')
    expect(typeof efs.lenses.identity).toBe('function')
  })
})

describe('lenses', () => {
  it('a literal lens resolves to its ordered addresses', async () => {
    expect(await lens(addr(1)).resolve({})).toEqual([addr(1)])
    expect(await lens([addr(1), addr(2)]).resolve({})).toEqual([addr(1), addr(2)])
  })

  it('identity resolves a bare address to itself (no chain needed)', async () => {
    expect(await identity(addr(7)).resolve({})).toEqual([addr(7)])
  })

  it('throws (never truncates) above MAX_LENSES', () => {
    const many = Array.from({ length: 21 }, (_, i) => addr(i + 1))
    expect(() => lens(many)).toThrow(MaxLensesExceeded)
  })
})
