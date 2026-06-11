import {
  http,
  type Address,
  type EIP1193Provider,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from 'viem'
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

  it('accepts the EIP-1193 provider form (standard boundary), wallet-gated by `account`', async () => {
    // A minimal EIP-1193 provider — the durable, library-neutral input.
    const provider = {
      request: async () => {
        throw new Error('mock')
      },
      on: () => {},
      removeListener: () => {},
    } as unknown as EIP1193Provider

    // No account → read-only client; read verb still resolves to NotImplemented.
    const ro = createEfsClient({ provider, chain: sepolia })
    await expect(ro.fs.read('/x')).rejects.toThrow(NotImplemented)

    // With an account → write-capable; write resolves to NotImplemented (not WalletRequired).
    const rw = createEfsClient({ provider, chain: sepolia, account: addr(1) })
    await expect(rw.fs.write('/x', new Uint8Array())).rejects.toThrow(NotImplemented)
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
