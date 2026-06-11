import { http, type Address, type WalletClient, createPublicClient, createWalletClient } from 'viem'
import { sepolia } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import {
  MaxLensesExceeded,
  NotImplemented,
  WalletRequired,
  createEfsClient,
  identity,
  lens,
} from '../src/index.js'

const publicClient = createPublicClient({ chain: sepolia, transport: http() })
const walletClient = createWalletClient({ chain: sepolia, transport: http() }) as WalletClient
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

describe('namespaced client (Decision F)', () => {
  it('read-only verbs reject with NotImplemented (async contract)', async () => {
    const efs = createEfsClient({ publicClient })
    await expect(efs.fs.read('/x')).rejects.toThrow(NotImplemented)
    await expect(
      (async () => {
        for await (const _ of efs.fs.list('/x')) break
      })(),
    ).rejects.toThrow(NotImplemented)
  })

  it('write methods are gated: WalletRequired without a wallet, NotImplemented with one', async () => {
    // The type hides `write` on a read-only client; at runtime the verb exists and
    // guards with WalletRequired (the backstop behind the type gate).
    const readOnly = createEfsClient({ publicClient }) as {
      fs: { write(p: string, c: Uint8Array): Promise<unknown> }
    }
    await expect(readOnly.fs.write('/x', new Uint8Array())).rejects.toThrow(WalletRequired)

    const writable = createEfsClient({ publicClient, walletClient })
    await expect(writable.fs.write('/x', new Uint8Array())).rejects.toThrow(NotImplemented)
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
