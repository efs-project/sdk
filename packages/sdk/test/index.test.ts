import {
  type Address,
  type EIP1193Provider,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionResult,
  toFunctionSelector,
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

  it('a read-only client TYPE-exposes the standalone READ namespaces (no wallet, no cast)', () => {
    // `createEfsClient({ publicClient })` is typed `EfsReadClient`. The lens-scoped, wallet-free
    // read verbs of graph/props/mirrors/redirects must be reachable WITHOUT a cast — these
    // property accesses only typecheck because EfsReadClient now carries the read views. (The
    // mutators add/set/place/remove are intentionally NOT on this type — write-client only.)
    const efs = createEfsClient({ publicClient })
    expect(typeof efs.graph.tags.active).toBe('function')
    expect(typeof efs.graph.tags.list).toBe('function')
    expect(typeof efs.graph.pins.active).toBe('function')
    expect(typeof efs.props.get).toBe('function')
    expect(typeof efs.props.list).toBe('function')
    expect(typeof efs.mirrors.list).toBe('function')
    expect(typeof efs.redirects.get).toBe('function')
  })

  it('rejects a chainless ViemConfig public client at construction', () => {
    // A viem client built from a bare transport (no `chain`) can answer getChainId() but
    // exposes no synchronous construction chain. The write/raw/eas paths resolve the
    // deployment sync from publicClient.chain.id and validate it against the live chain, so
    // a chainless client has no stable anchor — fail fast at construction with a clear,
    // actionable error instead of a confusing DeploymentNotFound on first write.
    const chainless = createPublicClient({
      transport: custom(createMockProvider({ chainId: 999_999 })),
    })
    expect(() => createEfsClient({ publicClient: chainless })).toThrow(/no bound `chain`/)
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

  it('guards reads against a chain switch BETWEEN live-deployment resolution and the read (TOCTOU)', async () => {
    // liveDeployment() resolves the deployment from getChainId() at time T; the read engines'
    // readContract/getCode run at T+1. A provider that switches chains in between would use the
    // resolved chain's addresses on the new chain (false misses / wrong-chain data). The read
    // client is guarded against the RESOLVED chain, so it fails closed. eth_chainId returns the
    // seeded Sepolia chain on the FIRST call (resolution) then drifts to 999999 (the read).
    let chainIdCalls = 0
    const drifting = createPublicClient({
      chain: sepolia,
      transport: custom(
        createMockProvider({
          handlers: {
            eth_chainId: () => {
              chainIdCalls += 1
              return chainIdCalls === 1 ? '0xaa36a7' : '0xf423f' // 11155111 (resolve) → 999999 (read)
            },
          },
        }),
      ),
    })
    const efs = createEfsClient({ publicClient: drifting })
    const err = await efs.fs.info('/x').catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain') // not a false miss on Sepolia addresses
  })

  it('standalone-namespace reads (graph.tags/pins, props, mirrors) guard the same TOCTOU', async () => {
    // These namespaces resolve liveDeployment() then read; they now route the read through a
    // guard pinned to the resolved chain, like readContext. mirrors.list: Sepolia at resolve
    // (call 1) → 999999 at the read (call 2) → WrongChain, not a false-empty on Sepolia addresses.
    let chainIdCalls = 0
    const drifting = createPublicClient({
      chain: sepolia,
      transport: custom(
        createMockProvider({
          handlers: {
            eth_chainId: () => {
              chainIdCalls += 1
              return chainIdCalls === 1 ? '0xaa36a7' : '0xf423f'
            },
          },
        }),
      ),
    })
    const efs = createEfsClient({ publicClient: drifting }) as unknown as {
      mirrors: { list(data: string, opts?: { lens?: Address }): Promise<unknown> }
    }
    const data = `0x${'1'.repeat(64)}` as const
    const err = await efs.mirrors.list(data, { lens: addr(9) }).catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
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

// ── efs.index repair verb — end-to-end over a mock EIP-1193 provider ────────────
// Regressions for the adversarial-review findings: (a) EFS-native-schema UIDs must
// short-circuit to 'already-indexed' (EFSIndexer.index() provably no-ops for them,
// EFSIndexer.sol:1272-1276 — sending a tx burns gas and reports a false 'indexed');
// (b) a mined-but-REVERTED indexer tx must throw (viem returns status:'reverted'
// without throwing), never report success.

describe('efs.index (repair verb) — honesty regressions', () => {
  const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
  const U = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`

  const DEP = {
    chainId: 31337,
    contracts: {
      eas: A(0xea5),
      schemaRegistry: A(0x5c4),
      indexer: A(0x1dc),
      router: A(0x707),
      fileView: A(0xf17),
      edgeResolver: A(0xed6),
      mirrorResolver: A(0x319),
      listResolver: A(0x715),
      listEntryResolver: A(0x71e),
      listReader: A(0x71a),
      aliasResolver: A(0xa11),
      systemAccount: A(0x5e5),
    },
    schemas: {
      anchor: U(0xa),
      property: U(0xb),
      data: U(0xc),
      pin: U(0xd),
      tag: U(0xe),
      mirror: U(0xf),
      list: U(0x100),
      listEntry: U(0x101),
      redirect: U(0x102),
    },
    transports: {},
  }

  /** Build a provider whose eth_call dispatches on (to, selector) and whose
   * tx/receipt methods drive the write leg. */
  function harness(opts: { attSchema: `0x${string}`; receiptStatus: '0x0' | '0x1' }) {
    const selGetAttestation = toFunctionSelector('getAttestation(bytes32)')
    const selIsIndexed = toFunctionSelector('isIndexed(bytes32)')
    const selIsRevoked = toFunctionSelector('isRevoked(bytes32)')
    const provider = createMockProvider({
      chainId: 31337,
      handlers: {
        eth_call: (params) => {
          const call = params[0] as { to: string; data: string }
          const sel = call.data.slice(0, 10)
          if (sel === selGetAttestation) {
            return encodeFunctionResult({
              abi: [
                {
                  type: 'function',
                  name: 'getAttestation',
                  stateMutability: 'view',
                  inputs: [{ name: 'uid', type: 'bytes32' }],
                  outputs: [
                    {
                      name: '',
                      type: 'tuple',
                      components: [
                        { name: 'uid', type: 'bytes32' },
                        { name: 'schema', type: 'bytes32' },
                        { name: 'time', type: 'uint64' },
                        { name: 'expirationTime', type: 'uint64' },
                        { name: 'revocationTime', type: 'uint64' },
                        { name: 'refUID', type: 'bytes32' },
                        { name: 'recipient', type: 'address' },
                        { name: 'attester', type: 'address' },
                        { name: 'revocable', type: 'bool' },
                        { name: 'data', type: 'bytes' },
                      ],
                    },
                  ],
                },
              ],
              functionName: 'getAttestation',
              result: {
                uid: U(0xabc),
                schema: opts.attSchema,
                time: 1n,
                expirationTime: 0n,
                revocationTime: 0n,
                refUID: U(0),
                recipient: A(0),
                attester: A(0xbee),
                revocable: true,
                data: '0x',
              },
            })
          }
          if (sel === selIsIndexed || sel === selIsRevoked) {
            return `0x${'0'.repeat(64)}` // false
          }
          throw new Error(`unhandled eth_call selector ${sel}`)
        },
        eth_sendTransaction: () => U(0x77),
        eth_getTransactionReceipt: () => ({
          transactionHash: U(0x77),
          transactionIndex: '0x0',
          blockHash: U(0xb10c),
          blockNumber: '0x1',
          from: A(0xbee),
          to: DEP.contracts.indexer,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'0'.repeat(512)}`,
          status: opts.receiptStatus,
          effectiveGasPrice: '0x1',
          type: '0x2',
        }),
        eth_estimateGas: () => '0x5208',
        eth_getBlockByNumber: () => ({
          number: '0x1',
          hash: U(0xb10c),
          timestamp: '0x1',
          baseFeePerGas: '0x1',
        }),
        eth_gasPrice: () => '0x1',
        eth_maxPriorityFeePerGas: () => '0x1',
        eth_getTransactionCount: () => '0x0',
      },
    })
    const chain31337 = { ...sepolia, id: 31337 }
    const pc = createPublicClient({ chain: chain31337, transport: custom(provider) })
    const wc = createWalletClient({
      chain: chain31337,
      account: A(0xbee),
      transport: custom(provider),
    }) as WalletClient
    const efs = createEfsClient({
      publicClient: pc,
      walletClient: wc,
      deployments: { 31337: DEP },
    }) as unknown as {
      index(uid: `0x${string}`): Promise<{ status: string; txHash?: `0x${string}` }>
    }
    return { efs, provider }
  }

  it("an EFS-native-schema UID (DATA) short-circuits to 'already-indexed' — NO tx is sent", async () => {
    const { efs, provider } = harness({ attSchema: DEP.schemas.data, receiptStatus: '0x1' })
    const out = await efs.index(U(0xabc))
    expect(out).toEqual({ status: 'already-indexed' })
    expect(provider.callCount('eth_sendTransaction')).toBe(0)
  })

  it('a mined-but-REVERTED indexer tx throws (ContractReverted), never a success verdict', async () => {
    const { efs } = harness({ attSchema: DEP.schemas.redirect, receiptStatus: '0x0' })
    const err = await efs.index(U(0xabc)).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('ContractReverted')
  })
})

describe('capability probe chain-pinning (review r3740495867)', () => {
  it('a provider that drifts between the chain sample and the getCode probe fails closed (WrongChain) — never caches chain-B code under chain A', async () => {
    // eth_chainId: first call (the sample) reports chain A; every later call
    // (the guarded probe's re-check) reports chain B — the drift window the
    // guard exists for.
    let chainCalls = 0
    const provider = createMockProvider({
      chainId: 31337, // unused — handler below overrides
      handlers: {
        eth_chainId: () => {
          chainCalls += 1
          return chainCalls === 1 ? '0x7a69' : '0x3e7' // 31337 then 999
        },
        eth_getCode: () => '0x6080604052', // would read as smart-account if trusted
      },
    })
    const chain31337 = { ...sepolia, id: 31337 }
    const pc = createPublicClient({ chain: chain31337, transport: custom(provider) })
    const wc = createWalletClient({
      chain: chain31337,
      account: addr(0xbee),
      transport: custom(provider),
    }) as WalletClient
    const efs = createEfsClient({ publicClient: pc, walletClient: wc }) as unknown as {
      account: { capabilities(): Promise<unknown> }
    }
    const err = await efs.account.capabilities().catch((e) => e)
    expect((err as { code?: string }).code).toBe('WrongChain')
  })
})
