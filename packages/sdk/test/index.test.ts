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
  DeploymentNotFound,
  MaxLensesExceeded,
  WalletRequired,
  createEfsClient,
  identity,
  lens,
} from '../src/index.js'

const publicClient = createPublicClient({ chain: sepolia, transport: http() })
const walletClient = createWalletClient({ chain: sepolia, transport: http() }) as WalletClient
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

describe('namespaced client (Decision F)', () => {
  it('read verbs are wired (read/locate/info/exists/list reach deployment resolution)', async () => {
    // The read verbs (read/readText/locate/info/exists/list) are now implemented. On
    // sepolia, where no EFS deployment is registered, a read passes the wiring and
    // reaches deployment resolution → DeploymentNotFound. That it is no longer
    // NotImplemented proves the verb is wired (same pattern as the write gate test).
    const efs = createEfsClient({ publicClient })
    await expect(efs.fs.read('/x')).rejects.toThrow(DeploymentNotFound)
    await expect(efs.fs.locate('/x')).rejects.toThrow(DeploymentNotFound)
    await expect(efs.fs.info('/x')).rejects.toThrow(DeploymentNotFound)
    await expect(efs.fs.exists('/x')).rejects.toThrow(DeploymentNotFound)
    await expect(
      (async () => {
        for await (const _ of efs.fs.list('/x')) break
      })(),
    ).rejects.toThrow(DeploymentNotFound)
  })

  it('overview is wired (reaches deployment resolution, no longer NotImplemented) — ADR-0011', async () => {
    // Implemented in ADR-0011: on sepolia (no EFS deployment) the read passes the
    // wiring and reaches deployment resolution → DeploymentNotFound, proving the verb
    // is wired (same pattern as the read verbs above).
    const efs = createEfsClient({ publicClient })
    await expect(efs.fs.overview('/x')).rejects.toThrow(DeploymentNotFound)
  })

  it('setOverview is wired + wallet-gated (ADR-0011)', async () => {
    const readOnly = createEfsClient({ publicClient }) as {
      fs: { setOverview(c: string, md: string): Promise<unknown> }
    }
    await expect(readOnly.fs.setOverview('/docs', '# hi')).rejects.toThrow(WalletRequired)
    const writable = createEfsClient({ publicClient, walletClient })
    await expect(writable.fs.setOverview('/docs', '# hi')).rejects.toThrow(DeploymentNotFound)
  })

  it('write methods are gated: WalletRequired without a wallet, wired with one', async () => {
    // The type hides `write` on a read-only client; at runtime the verb exists and
    // guards with WalletRequired (the backstop behind the type gate).
    const readOnly = createEfsClient({ publicClient }) as {
      fs: { write(p: string, c: Uint8Array): Promise<unknown> }
    }
    await expect(readOnly.fs.write('/x', new Uint8Array())).rejects.toThrow(WalletRequired)

    // With a wallet the write is now wired (Tier-1). On a chain with no registered
    // EFS deployment it passes the wallet gate and reaches deployment resolution —
    // DeploymentNotFound proves it's wired (it is no longer NotImplemented).
    const writable = createEfsClient({ publicClient, walletClient })
    await expect(writable.fs.write('/x', new Uint8Array())).rejects.toThrow(DeploymentNotFound)
  })

  it('exposes lens helpers under efs.lenses', () => {
    const efs = createEfsClient({ publicClient })
    expect(typeof efs.lenses.lens).toBe('function')
    expect(typeof efs.lenses.identity).toBe('function')
  })

  it('exposes a bigint-safe efs.toJSON on a read-only client (review P3 DX)', () => {
    const efs = createEfsClient({ publicClient })
    expect(typeof efs.toJSON).toBe('function')
    expect(efs.toJSON({ size: 1024n })).toBe('{"size":"1024"}')
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

    // No account → read-only client; the read verb is wired and reaches deployment
    // resolution (DeploymentNotFound on sepolia, where none is registered).
    const ro = createEfsClient({ provider, chain: sepolia })
    await expect(ro.fs.read('/x')).rejects.toThrow(DeploymentNotFound)

    // With an account → write-capable; write is wired (Tier-1) and passes the
    // wallet gate, reaching deployment resolution (DeploymentNotFound on a chain
    // with no registered EFS deployment) — not WalletRequired, not NotImplemented.
    const rw = createEfsClient({ provider, chain: sepolia, account: addr(1) })
    await expect(rw.fs.write('/x', new Uint8Array())).rejects.toThrow(DeploymentNotFound)
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
