/**
 * Fork tests (opt-in). Two suites:
 *
 *  1. `fork smoke (prool + Anvil)` — gated on `EFS_FORK_RPC_URL`; spins a fresh
 *     Anvil fork via prool and asserts EAS bytecode is present. Scaffold only.
 *
 *  2. `fork write→read round-trip (live deploy)` — gated on `EFS_FORK_TEST=1`;
 *     talks to an ALREADY-RUNNING local Sepolia-fork node (Hardhat `yarn chain`)
 *     at `EFS_FORK_NODE_URL` (default http://127.0.0.1:8545) where the EFS system
 *     has been deployed (`yarn deploy:efs` + `yarn deploy:efs-views`). It proves
 *     the SDK's public `efs.fs.write` → `efs.fs.cat` pipeline end-to-end against
 *     the real frozen resolvers: a file is written (DATA + MIRROR + reserved-key
 *     PROPERTYs + placement PIN, one multiAttest per DAG layer), then read back
 *     and byte-verified with a `matches-author` verification status.
 *
 *     The live deployment (addresses + schema UIDs + transport anchors) is passed
 *     to the SDK via the `deployments` config override (ADR-0005). Override the
 *     captured values with EFS_* env vars when re-deploying produces fresh ones.
 *
 *   EFS_FORK_TEST=1 pnpm --filter @efs/sdk test fork
 *
 * ## Transport choice (why `https://` and not the default inline `data:`)
 *
 * The SDK's default inline path mints a `data:` MIRROR, but the on-chain
 * MirrorResolver's `_isAllowedScheme` REJECTS `data:` (it is an inline-payload /
 * active-content scheme excluded for XSS safety), and the bootstrap seeds no
 * `/transports/data` anchor anyway. So the default write would revert at the
 * MIRROR layer. For a self-contained round-trip we publish an `https://` MIRROR
 * (an allowed scheme, with a seeded `/transports/https` anchor) pointing at a
 * tiny in-test loopback server, and read it back with the SSRF guard disabled
 * (`allowPrivateHosts` — the caller owns egress here). This exercises the real
 * MIRROR `onAttest` validation AND the real fetch+verify read path.
 */

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { http, type Chain, type Hex, createPublicClient, createWalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type DeploymentsMap, type EfsDeployment, createEfsClient } from '../src/index.js'
import {
  type AnvilFork,
  FORK_EAS_ADDRESS,
  forkEnabled,
  startAnvilFork,
} from './helpers/anvil-fork.js'

// ── prool smoke suite (existing) ─────────────────────────────────────────────
describe.skipIf(!forkEnabled())('fork smoke (prool + Anvil)', () => {
  let fork: AnvilFork

  beforeAll(async () => {
    fork = await startAnvilFork()
  }, 60_000)

  afterAll(async () => {
    await fork?.stop()
  })

  it('EAS bytecode is present on the fork', async () => {
    const client = createPublicClient({ transport: http(fork.rpcUrl) })
    const code = await client.getCode({ address: FORK_EAS_ADDRESS })
    expect(code).toBeDefined()
    expect(code).not.toBe('0x')
    expect(code?.length ?? 0).toBeGreaterThan(2)
  })
})

// ── Live write→read round-trip suite ─────────────────────────────────────────

const liveEnabled = process.env.EFS_FORK_TEST === '1'
const NODE_URL = process.env.EFS_FORK_NODE_URL ?? 'http://127.0.0.1:8545'
const CHAIN_ID = 31337

/** Hardhat default account #0 — funded on the fork. The private key is a public
 * well-known hardhat test key (NOT a secret); the deployer key in .env is never
 * used here. */
const ACCOUNT_0_PK =
  (process.env.EFS_FORK_ACCOUNT_PK as Hex | undefined) ??
  ('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex)

const env = (k: string, fallback: string) => (process.env[k] ?? fallback) as Hex

/**
 * The live deployment captured from `yarn deploy:efs` + `yarn deploy:efs-views`
 * against the pinned Sepolia fork (block 10691000). Every value is overridable
 * via env so a fresh deploy can be plugged in without editing the test.
 */
const deployment: EfsDeployment = {
  chainId: CHAIN_ID,
  contracts: {
    eas: env('EFS_FORK_EAS', '0xC2679fBD37d54388Ce493F1DB75320D236e1815e'),
    schemaRegistry: env('EFS_FORK_SCHEMA_REGISTRY', '0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0'),
    indexer: env('EFS_FORK_INDEXER', '0x7B2dE8E2c646B73c084610d8553F0E63F5D493Dd'),
    router: env('EFS_FORK_ROUTER', '0x3baB7655d354833e99d74929AA2DC1eDf804c029'),
    fileView: env('EFS_FORK_FILE_VIEW', '0x99f7E11337fbC1c9D750ac5a6C1804A6c658602D'),
    edgeResolver: env('EFS_FORK_EDGE_RESOLVER', '0xb40297CC4ccD2f837CcF75831B5fA2cAb96C1CFe'),
    mirrorResolver: env('EFS_FORK_MIRROR_RESOLVER', '0xf844378a282FB3F9A4c2A47DaD3Be1706c6f3226'),
    listResolver: env('EFS_FORK_LIST_RESOLVER', '0xdEAb8859ab356B5db7c27313eE079461cB87e137'),
    listEntryResolver: env(
      'EFS_FORK_LIST_ENTRY_RESOLVER',
      '0x9Dd2CAE58F9F46280D84aE0ef31c243dc5dAd8aA',
    ),
    listReader: env('EFS_FORK_LIST_READER', '0x2AFe2Bc4A10505fDf765F5709eD13355c68e6287'),
    aliasResolver: env('EFS_FORK_ALIAS_RESOLVER', '0xB0B76064eE417f7568427cbd3fDAcB2e5589743d'),
    systemAccount: env('EFS_FORK_SYSTEM_ACCOUNT', '0x19b249b3E733049f7B97DFddb6dE60c4Bf95C205'),
  },
  schemas: {
    anchor: env(
      'EFS_FORK_SCHEMA_ANCHOR',
      '0x1a17b1f94e15395122748852d9a45723bfd7089d730cdddb498b172f5bee7176',
    ),
    property: env(
      'EFS_FORK_SCHEMA_PROPERTY',
      '0x88cba9fc420b0d5394ed03a581fca70ad5ea6253fcb5a2196dad86dd057860ba',
    ),
    data: env(
      'EFS_FORK_SCHEMA_DATA',
      '0xfa3fb79f9180a924856557413de8f379538148e8a47c5881271c32830a6cadff',
    ),
    pin: env(
      'EFS_FORK_SCHEMA_PIN',
      '0x06d8d3628e7bc1e8a33cd54dcefdb70c877afa2c7179e3b188661f07a3c22b4e',
    ),
    tag: env(
      'EFS_FORK_SCHEMA_TAG',
      '0x53ae8b0f792a49ce8fb480049e90aa0116fa52f73cf01b08b18f0327b5df22fe',
    ),
    mirror: env(
      'EFS_FORK_SCHEMA_MIRROR',
      '0x2d7cf6abc5080ce36256dfcfb9e0dacc01658f1113998c1873348f79611dc6a7',
    ),
    list: env(
      'EFS_FORK_SCHEMA_LIST',
      '0x47e63dd52508e29912f14ff549a1eedc2c443b640fb15c0d9657a46a9f61db89',
    ),
    listEntry: env(
      'EFS_FORK_SCHEMA_LIST_ENTRY',
      '0xc607c28b4b4c21888a9aca34ad8e02d2a268a31e7a830321f3083dc476b1edd7',
    ),
    redirect: env(
      'EFS_FORK_SCHEMA_REDIRECT',
      '0x17fbaa8e0cc14d91b95b4d8417b79d068dfacc8b1273ea2ca5da532e2d0c9e0d',
    ),
  },
  // Per-scheme `/transports/<scheme>` anchor UIDs (read back via
  // EFSIndexer.resolvePath). `web3://` lives under the `onchain` anchor; `ar://`
  // under `arweave`. There is deliberately NO `data` transport (the bootstrap
  // seeds none, and MirrorResolver rejects the data: scheme).
  transports: {
    web3: env(
      'EFS_FORK_T_ONCHAIN',
      '0x17e6765916820cecd625c1c0d84b737022480534797e475ed3e3484d525a316c',
    ),
    ipfs: env(
      'EFS_FORK_T_IPFS',
      '0xf0325588de1b28f6c0de49192443c06a42823be97d1a9c2bde2bcb6cd66ab114',
    ),
    arweave: env(
      'EFS_FORK_T_ARWEAVE',
      '0xdec9de755af10d6b7a64d7eb2301a3d666e1ccc959c5567d5be79906b663aff7',
    ),
    magnet: env(
      'EFS_FORK_T_MAGNET',
      '0x3724c1e9b19755f5535e3781ea90c53703e4fb0494415d9b0bd3247063bab7b6',
    ),
    https: env(
      'EFS_FORK_T_HTTPS',
      '0x38dd5d54209e9d1db3afcbf11a86f807c1a822130ba1ce8507d9627616f9d725',
    ),
  },
}

const deployments: DeploymentsMap = { [CHAIN_ID]: deployment }

const localChain = {
  id: CHAIN_ID,
  name: 'EFS Sepolia Fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [NODE_URL] } },
} as const satisfies Chain

describe.skipIf(!liveEnabled)('fork write→read round-trip (live deploy)', () => {
  let server: Server
  let httpOrigin: string
  let mirrorUrl: string
  // Unique per run: the file-ANCHOR name slot is permanent (non-revocable), so a
  // re-run at a fixed path would revert on the duplicate name. A run-scoped suffix
  // keeps repeated runs against the same long-lived fork node clean.
  const runId = Date.now().toString(36)
  const filePath = `/hello-efs-${runId}.txt`
  const payload = new TextEncoder().encode(`hello, EFS — live fork round-trip ${runId} ✅`)

  // A `fetch` stub that maps the on-chain `https://` mirror URL back onto the
  // plain-HTTP loopback server. The MIRROR carries an `https://` URI because the
  // resolver requires an allowed scheme (it rejects `data:` and has no http://),
  // but standing up TLS with a trusted cert for a throwaway test is overkill —
  // so the read side fetches the same path over the local HTTP origin. The bytes
  // (and therefore the hash verification) are identical; only the transport hop
  // is rewritten. Injected via the SDK's `fetchImpl` read option.
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rewritten = url.replace(/^https:\/\/127\.0\.0\.1:\d+/, httpOrigin)
    return fetch(rewritten, init)
  }

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(Buffer.from(payload))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    httpOrigin = `http://127.0.0.1:${port}`
    // The scheme MUST be one MirrorResolver allows (https://) and have a seeded
    // /transports/https anchor. The host is the loopback origin.
    mirrorUrl = `https://127.0.0.1:${port}/hello-efs.txt`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('writes a file and reads its bytes back verified', async () => {
    const account = privateKeyToAccount(ACCOUNT_0_PK)
    // The fork node's multiAttest (resolver ancestor-walks + index writes) is slow
    // to estimate/mine; lift viem's default 10s HTTP timeout so estimateGas/wait
    // don't abort a legitimately-pending tx.
    const transport = http(NODE_URL, { timeout: 90_000 })
    const publicClient = createPublicClient({ chain: localChain, transport })
    const walletClient = createWalletClient({ account, chain: localChain, transport })

    const efs = createEfsClient({ publicClient, walletClient, deployments })

    // Sanity: the override deployment is real bytecode on this chain.
    await efs.raw.verifyDeployment()

    // ── WRITE ──────────────────────────────────────────────────────────────
    // Parent is root (bootstrap created it), so no mkdir is needed. We supply an
    // explicit `https://` mirror (the loopback server) instead of the default
    // inline `data:` mirror, which the on-chain MirrorResolver would reject.
    const receipt = await efs.fs.write(filePath, payload, {
      mirrors: [mirrorUrl],
      contentType: 'text/plain; charset=utf-8',
    })

    expect(receipt.status).toBe('confirmed')
    expect(receipt.data?.uid).toMatch(/^0x[0-9a-f]{64}$/)
    expect(receipt.steps.length).toBeGreaterThan(0)
    // DATA + file-ANCHOR + MIRROR + 3 key-ANCHORs + 3 PROPERTYs + 3 binding-PINs
    // + placement-PIN = 12 attestations across 3 layers.
    expect(receipt.steps.every((s) => s.done)).toBe(true)

    // ── LOCATE (pointer-only) ─────────────────────────────────────────────────
    const located = await efs.fs.locate(filePath)
    expect(located).not.toBeNull()
    expect(located?.data.uid).toBe(receipt.data?.uid)
    // The winning lens is the wallet account (the attester).
    expect(located?.resolvedBy.toLowerCase()).toBe(account.address.toLowerCase())

    // ── READ (fetch + verify bytes) ───────────────────────────────────────────
    // allowPrivateHosts lets the engine fetch the loopback mirror; the SSRF
    // guard would otherwise block 127.0.0.1.
    const file = await efs.fs.read(filePath, { allowPrivateHosts: true, fetchImpl })

    expect(file.verification).toBe('matches-author')
    expect(new Uint8Array(file.bytes)).toEqual(payload)
    expect(file.hashAuthor.toLowerCase()).toBe(account.address.toLowerCase())
  }, 300_000)
})
