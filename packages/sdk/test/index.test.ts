import {
  type Address,
  type EIP1193Provider,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
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
import { createMockProvider } from './helpers/mock-eip1193.js'

// An UNREGISTERED chain — Sepolia (11155111) is now seeded in the built-in registry, so
// these "the verb is wired" tests use a chain with no EFS deployment, where reaching
// deployment resolution still surfaces DeploymentNotFound (the signal they rely on). The
// transport is a mock that reports chainId 999999 for `eth_chainId` (reads now resolve the
// deployment from the LIVE provider chain) — deterministic, no network.
const noDeployChain = { ...sepolia, id: 999_999 } as const
const noDeployTransport = custom(createMockProvider({ chainId: 999_999 }))
const publicClient = createPublicClient({ chain: noDeployChain, transport: noDeployTransport })
const walletClient = createWalletClient({
  chain: noDeployChain,
  transport: noDeployTransport,
}) as WalletClient
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
      // Answer eth_chainId (reads resolve the deployment from the live chain) with the
      // unregistered 999999; everything else throws (no deployment ⇒ short-circuits first).
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return `0x${(999_999).toString(16)}`
        throw new Error('mock')
      },
      on: () => {},
      removeListener: () => {},
    } as unknown as EIP1193Provider

    // No account → read-only client; the read verb is wired and reaches deployment
    // resolution (DeploymentNotFound on an unregistered chain).
    const ro = createEfsClient({ provider, chain: noDeployChain })
    await expect(ro.fs.read('/x')).rejects.toThrow(DeploymentNotFound)

    // With an account → write-capable; write is wired (Tier-1) and passes the
    // wallet gate, reaching deployment resolution (DeploymentNotFound on a chain
    // with no registered EFS deployment) — not WalletRequired, not NotImplemented.
    const rw = createEfsClient({ provider, chain: noDeployChain, account: addr(1) })
    await expect(rw.fs.write('/x', new Uint8Array())).rejects.toThrow(DeploymentNotFound)
  })

  it('reads resolve the deployment from the LIVE provider chain, not the bound chain', async () => {
    // The publicClient is BOUND to Sepolia (a seeded chain) but the provider's live
    // eth_chainId reports 999999 (no deployment). A read must resolve from the LIVE chain
    // → DeploymentNotFound, proving it doesn't trust the construction-time bound chain (a
    // mutable provider that switched networks). With the old bound-chain resolution this
    // would have resolved Sepolia and NOT thrown.
    const drifted = createPublicClient({
      chain: sepolia, // bound = 11155111 (seeded)
      transport: custom(createMockProvider({ chainId: 999_999 })), // live = 999999 (unseeded)
    })
    const efs = createEfsClient({ publicClient: drifted })
    await expect(efs.fs.info('/x')).rejects.toThrow(DeploymentNotFound)
    await expect(efs.fs.read('/x')).rejects.toThrow(DeploymentNotFound)
  })

  it('efs.raw.*.write.* is guarded against a wrong-chain wallet (WrongChain)', async () => {
    // The deployment resolves to Sepolia (publicClient bound there), but the wallet's live
    // chain is 999999 — a raw `.write.*` must fail closed like the higher-level verbs,
    // not broadcast to the wallet chain at the deployment's addresses.
    const pub = createPublicClient({
      chain: sepolia,
      transport: custom(createMockProvider({ chainId: 11_155_111 })),
    })
    const wal = createWalletClient({
      chain: sepolia,
      account: addr(7),
      transport: custom(createMockProvider({ chainId: 999_999 })), // live wallet chain ≠ deployment
    }) as WalletClient
    const efs = createEfsClient({ publicClient: pub, walletClient: wal })
    const rawEasWrite = (
      efs.raw.eas as unknown as { write: { revoke: (a: unknown) => Promise<unknown> } }
    ).write
    const err = await rawEasWrite
      .revoke([{ schema: `0x${'0'.repeat(64)}`, data: { uid: `0x${'0'.repeat(64)}`, value: 0n } }])
      .catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
  })

  it('guards an UNBOUND raw wallet with a per-call account against a wrong chain', async () => {
    // viem raw writes accept a per-call `account` even with no bound wallet account, so the
    // chain guard must fire regardless of a bound account — else an unbound wallet on a
    // different chain could broadcast `efs.raw.*.write.*(.., { account })` to the wrong chain.
    const pub = createPublicClient({
      chain: sepolia,
      transport: custom(createMockProvider({ chainId: 11_155_111 })),
    })
    const wal = createWalletClient({
      chain: sepolia, // NO bound account; live chain 999999 ≠ deployment (11155111)
      transport: custom(createMockProvider({ chainId: 999_999 })),
    }) as WalletClient
    const efs = createEfsClient({ publicClient: pub, walletClient: wal })
    const rawEasWrite = (
      efs.raw.eas as unknown as { write: { revoke: (a: unknown, o: unknown) => Promise<unknown> } }
    ).write
    const err = await rawEasWrite
      .revoke(
        [{ schema: `0x${'0'.repeat(64)}`, data: { uid: `0x${'0'.repeat(64)}`, value: 0n } }],
        {
          account: addr(1), // per-call account on an unbound wallet
        },
      )
      .catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
  })

  it('guards raw READS against a wrong-chain (drifted) provider', async () => {
    // The raw read instances are bound to the construction-time deployment addresses; a
    // provider that switched networks must fail closed (WrongChain), not read the old
    // addresses on the new chain. publicClient bound to Sepolia, live eth_chainId 999999.
    const drifted = createPublicClient({
      chain: sepolia,
      transport: custom(createMockProvider({ chainId: 999_999 })),
    })
    const efs = createEfsClient({ publicClient: drifted })
    const rawRead = (
      efs.raw.indexer as unknown as { read: { rootAnchorUID: () => Promise<unknown> } }
    ).read
    const err = await rawRead.rootAnchorUID().catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
  })

  it('standalone-namespace reads resolve the deployment from the LIVE chain', async () => {
    // graph.tags/pins, props, mirrors reads must follow the live provider chain like fs.*
    // (not the construction-time bound chain). Bound to Sepolia (seeded) but live = 999999
    // (no deployment) → DeploymentNotFound, proving the read used `liveDeployment`.
    const drifted = createPublicClient({
      chain: sepolia,
      transport: custom(createMockProvider({ chainId: 999_999 })),
    })
    const efs = createEfsClient({ publicClient: drifted }) as unknown as {
      mirrors: { list(data: string): Promise<unknown> }
      props: { list(data: string): Promise<unknown> }
    }
    const data = `0x${'1'.repeat(64)}`
    await expect(efs.mirrors.list(data)).rejects.toThrow(DeploymentNotFound)
    await expect(efs.props.list(data)).rejects.toThrow(DeploymentNotFound)
  })

  it('fs.write guards the PUBLIC client chain, not just the wallet (WrongChain)', async () => {
    // The wallet is on the deployment chain (Sepolia) but the public client — used for
    // parent reads + receipt wait — drifted to 999999. The write must fail closed, else it
    // would send on Sepolia yet read/wait on the wrong chain.
    const pub = createPublicClient({
      chain: sepolia, // bound deployment chain = 11155111
      transport: custom(createMockProvider({ chainId: 999_999 })), // but LIVE = 999999
    })
    const wal = createWalletClient({
      chain: sepolia,
      account: addr(7),
      transport: custom(createMockProvider({ chainId: 11_155_111 })), // wallet on Sepolia (matches)
    }) as WalletClient
    const efs = createEfsClient({ publicClient: pub, walletClient: wal })
    const err = await efs.fs.write('/x', new Uint8Array([1])).catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
  })

  it('efs.eas.getAttestation / efs.decode(uid) guard a drifted public chain', async () => {
    // getAttestation (and decode(uid), which uses it) reads at the construction-chain EAS
    // address; on a drifted provider it must fail closed rather than hit the old address on
    // the new chain. Bound to Sepolia, live 999999.
    const drifted = createPublicClient({
      chain: sepolia,
      transport: custom(createMockProvider({ chainId: 999_999 })),
    })
    const efs = createEfsClient({ publicClient: drifted }) as unknown as {
      eas: { getAttestation(uid: string): Promise<unknown> }
      decode(uid: string): Promise<unknown>
    }
    const uid = `0x${'2'.repeat(64)}`
    expect(((await efs.eas.getAttestation(uid).catch((e) => e)) as { code?: string }).code).toBe(
      'WrongChain',
    )
    expect(((await efs.decode(uid).catch((e) => e)) as { code?: string }).code).toBe('WrongChain')
  })

  it('efs.account.capabilities() keys the probe by the LIVE chain, not the construction chain', async () => {
    // `getCode` (which classifies `kind`) lands on the provider's CURRENT chain, so the
    // detection cache must be keyed by the LIVE chain too. Both clients are BOUND to the
    // same chain (Sepolia) but their providers report different live chains, with the SAME
    // address resolving to different bytecode per network. Under the old construction-time
    // keying both would share one cache slot and the second would report the first's stale
    // `kind`; keying by the live chain gives each its own correct profile.
    const probeAddr = addr(0xca9a) // unique to this test (detect cache is module-level)
    const mkPublic = (liveChainId: number, code: string) =>
      createPublicClient({
        chain: sepolia, // identical construction-time bound chain for both
        transport: custom(createMockProvider({ chainId: liveChainId, code })),
      })
    const mkWallet = (liveChainId: number, code: string) =>
      createWalletClient({
        chain: sepolia,
        account: probeAddr,
        transport: custom(createMockProvider({ chainId: liveChainId, code })),
      }) as WalletClient
    const cap = (liveChainId: number, code: string) =>
      (
        createEfsClient({
          publicClient: mkPublic(liveChainId, code),
          walletClient: mkWallet(liveChainId, code),
        }) as unknown as { account: { capabilities(): Promise<{ kind: string }> } }
      ).account.capabilities()

    // Live chain 1: no code → EOA. Live chain 2: same address, deployed bytecode → smart.
    expect((await cap(1, '0x')).kind).toBe('eoa')
    expect((await cap(2, '0x6080604052')).kind).toBe('smart-account')
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
