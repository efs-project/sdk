/**
 * Local-fork EFS deployment fixture (chainId 31337) — for SDK integration tests.
 *
 * This is a reusable {@link DeploymentsMap} entry the SDK can pass as the `deployments`
 * override (ADR-0005 / ADR-0012: the SDK is a client + address book, not a deployer; a
 * local/custom chain is supplied via the config override). Use it to construct a client
 * against a locally-deployed EFS on a Sepolia fork:
 *
 *   import { LOCAL_DEPLOYMENTS, LOCAL_CHAIN_ID } from './fixtures/local-deployment.js'
 *   const efs = createEfsClient({ provider, deployments: LOCAL_DEPLOYMENTS })
 *
 * ── How this was produced (the exact repeatable commands) ──────────────────────────────
 * Source repo: efs-project/contracts @ origin/main commit 21b737c
 *   ("Freeze schemas and enable upgradable contracts"). No checkout needed if your local
 *   contracts tree is already on main; otherwise `git fetch && git checkout origin/main`.
 *
 *   # 1. Start a Sepolia fork at the pinned block (10_691_000, ADR-0037) with CreateX present.
 *   #    The pinned-Sepolia fork inherits CreateX (0xba5Ed0…ba5Ed, verified present at the pin).
 *   #    NOTE: in packages/hardhat/.env, SEPOLIA_FORK_RPC_URL and ALCHEMY_API_KEY are BLANK and
 *   #    FORK_BLOCK is "" (empty). The config uses `Number(process.env.FORK_BLOCK ?? 10_691_000)`,
 *   #    and `??` keeps "" → Number("") = 0 → fork at genesis (no CreateX). So you MUST pass a
 *   #    real archive RPC as SEPOLIA_FORK_RPC_URL *and* set FORK_BLOCK explicitly:
 *   cd packages/hardhat
 *   SEPOLIA_FORK_RPC_URL="<archive-sepolia-rpc>" MAINNET_FORKING_ENABLED=true FORK_BLOCK=10691000 \
 *     npx hardhat node --network hardhat --no-deploy        # serves 127.0.0.1:8545, chainId 31337
 *
 *   # 2. Deploy the frozen EFS core (6 CREATE3 resolver proxies + SystemAccount + 9 schemas).
 *   #    LOCALHOST_RPC_URL override is REQUIRED: .env ships LOCALHOST_RPC_URL="" and the config
 *   #    uses `?? "http://127.0.0.1:8545"` (NOT `||`), so the empty string is kept → HH117
 *   #    "Empty string for network URL". Override it back to the fork:
 *   LOCALHOST_RPC_URL=http://127.0.0.1:8545 yarn deploy:efs --network localhost
 *   #    The EOA path is gated to chainId 31337 and runs: deploy proxies → verify gate →
 *   #    wireContracts → register the 9 schemas LAST. (See contracts docs/DEPLOYMENT.md §3b.)
 *
 *   # 3. Deploy the 3 stateless views (EFSFileView, EFSRouter, ListReader) against the proxies:
 *   LOCALHOST_RPC_URL=http://127.0.0.1:8545 yarn deploy:efs-views --network localhost
 *
 * ── Provenance / verification ──────────────────────────────────────────────────────────
 * The 6 resolver proxies + SystemAccount proxy are CREATE3-deterministic (keyed to the
 * account-0 deployer 0xf39Fd6…2266 + committed salts), so they reproduce byte-identically on
 * every fresh fork at this commit. The 9 schema UIDs are derived as
 * keccak256(fieldString, proxyAddr, revocable) and were verified ON-CHAIN against the
 * SchemaRegistry (0x0a7E2Ff…50D0): every field string, `revocable` flag, and resolver binding
 * matches contracts/docs/SEPOLIA_FREEZE_TABLE.md exactly.
 *
 * eas + schemaRegistry are the canonical Sepolia (CREATE2) addresses, present on the fork.
 *
 * ⚠️ View-address caveat: EFSFileView / EFSRouter / ListReader are deployed with plain CREATE
 * (nonce-based), NOT CREATE3 — they are non-frozen and in no schema UID (DEPLOYMENT.md §0). The
 * addresses below are from a run where the deployer's nonce was post-core-deploy; if you redeploy
 * from a different nonce they will differ. They are NOT part of the freeze and are freely
 * redeployable. The proxies + schema UIDs are the stable, reproducible part. For an
 * integrity-checked client (assertDeploymentIntegrity), redeploy the views and update these three
 * if your local run yields different addresses.
 *
 * Generated 2026-06-18 against a local Sepolia fork (Infura archive RPC, block 10_691_000).
 */

import type { Address, Hex } from 'viem'
import type {
  DeploymentsMap,
  EfsContracts,
  EfsDeployment,
  EfsSchemaUIDs,
} from '../../src/chain/deployments.js'

/** The local Anvil/Hardhat Sepolia-fork chain id. */
export const LOCAL_CHAIN_ID = 31337 as const

/**
 * EFS + EAS contract addresses on the local fork.
 * - eas / schemaRegistry: canonical Sepolia deployments (present on the fork).
 * - indexer / *Resolver / systemAccount: CREATE3-deterministic proxies (stable across runs).
 * - router / fileView / listReader: plain-CREATE views (see view-address caveat above).
 */
export const LOCAL_CONTRACTS: EfsContracts = {
  eas: '0xC2679fBD37d54388Ce493F1DB75320D236e1815e' as Address,
  schemaRegistry: '0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0' as Address,
  indexer: '0x7B2dE8E2c646B73c084610d8553F0E63F5D493Dd' as Address,
  router: '0xe9e0e645C145E9d99246aB522AFF724F31F95E00' as Address,
  fileView: '0x14C91E7093cCc3E40656FF844519162A79963721' as Address,
  edgeResolver: '0xb40297CC4ccD2f837CcF75831B5fA2cAb96C1CFe' as Address,
  mirrorResolver: '0xf844378a282FB3F9A4c2A47DaD3Be1706c6f3226' as Address,
  listResolver: '0xdEAb8859ab356B5db7c27313eE079461cB87e137' as Address,
  listEntryResolver: '0x9Dd2CAE58F9F46280D84aE0ef31c243dc5dAd8aA' as Address,
  listReader: '0xdAC7424d00eA6Fc56069f548049884E0b31316FD' as Address,
  aliasResolver: '0xB0B76064eE417f7568427cbd3fDAcB2e5589743d' as Address,
  systemAccount: '0x19b249b3E733049f7B97DFddb6dE60c4Bf95C205' as Address,
}

/**
 * The frozen EFS schema-UID set (the canonical 9). Verified on-chain against the
 * SchemaRegistry; field strings + revocable flags match SEPOLIA_FREEZE_TABLE.md:
 *   anchor    `string name, bytes32 forSchema`                                     revocable=false
 *   property  `string value`                                                       revocable=false
 *   data      `` (empty — pure identity, ADR-0049)                                 revocable=false
 *   pin       `bytes32 definition`                                                 revocable=true
 *   tag       `bytes32 definition, int256 weight`                                  revocable=true
 *   mirror    `bytes32 transportDefinition, string uri`                            revocable=true
 *   list      `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries`  revocable=false
 *   listEntry `bytes32 listUID, bytes32 target`                                    revocable=true
 *   redirect  `bytes32 target, uint16 kind`                                        revocable=true
 */
export const LOCAL_SCHEMA_UIDS: EfsSchemaUIDs = {
  anchor: '0x1a17b1f94e15395122748852d9a45723bfd7089d730cdddb498b172f5bee7176' as Hex,
  property: '0x88cba9fc420b0d5394ed03a581fca70ad5ea6253fcb5a2196dad86dd057860ba' as Hex,
  data: '0xfa3fb79f9180a924856557413de8f379538148e8a47c5881271c32830a6cadff' as Hex,
  pin: '0x06d8d3628e7bc1e8a33cd54dcefdb70c877afa2c7179e3b188661f07a3c22b4e' as Hex,
  tag: '0x53ae8b0f792a49ce8fb480049e90aa0116fa52f73cf01b08b18f0327b5df22fe' as Hex,
  mirror: '0x2d7cf6abc5080ce36256dfcfb9e0dacc01658f1113998c1873348f79611dc6a7' as Hex,
  list: '0x47e63dd52508e29912f14ff549a1eedc2c443b640fb15c0d9657a46a9f61db89' as Hex,
  listEntry: '0xc607c28b4b4c21888a9aca34ad8e02d2a268a31e7a830321f3083dc476b1edd7' as Hex,
  redirect: '0x17fbaa8e0cc14d91b95b4d8417b79d068dfacc8b1273ea2ca5da532e2d0c9e0d' as Hex,
}

/** The chainId-31337 deployment entry. */
export const LOCAL_DEPLOYMENT: EfsDeployment = {
  chainId: LOCAL_CHAIN_ID,
  contracts: LOCAL_CONTRACTS,
  schemas: LOCAL_SCHEMA_UIDS,
}

/** A {@link DeploymentsMap} ready to pass as the `deployments` client-config override. */
export const LOCAL_DEPLOYMENTS: DeploymentsMap = {
  [LOCAL_CHAIN_ID]: LOCAL_DEPLOYMENT,
}
