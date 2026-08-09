# Future-proofing & engineering doctrine

> Synthesis of a 9-domain research pass (2026-06-11) beyond the core EIP/ERC table in [standards.md](./standards.md): SDK engineering, storage/durability, indexing & history-expiry, security/clear-signing, gas & tx-lifecycle, L2/interop, key-management, the Ethereum roadmap, and metadata. Tags: **ADOPT** · **SEAM** · **WATCH** · **AVOID**. This is the doctrine the `fs.*`/read/write modules are built against.

## The three load-bearing constraints (design around these)

1. **History expires (EIP-4444).** Partial history expiry shipped July 2025; rolling ~1-year expiry is the roadmap. `eth_getLogs` over deep history is officially unreliable. **→ Reads are index-first.** Resolve via *current state* (`getAttestation(uid)`, SSTORE2 `eth_call`) and an indexer; never replay genesis logs at runtime. Live attestation/content reads are unaffected — only history is.
2. **Calldata gets costly and capped.** EIP-7623 (live, Pectra) makes calldata-heavy writes ~2.5× pricier; EIP-7825 (live, Fusaka Dec 2025) caps a single tx at ~16.7M gas. **→ Writes chunk under the cap; "hash-on-chain, bytes-off-chain" is the default**, full on-chain bytes opt-in.
3. **A hash proves integrity, not availability.** Content addressing is tamper-evidence, not durability. **→ Pair a fast mirror with a permanent one; verify every fetched byte against `contentHash`.**

## 1. SDK engineering — ADOPT the wevm stack

- **ABI codegen:** `@wagmi/cli` (foundry plugin) → generated typed bindings + the per-chain **`@efs/sdk/deployments`** map from contract artifacts. *Cheap, directly needed.*
- **Testing:** **vitest + prool** (the wevm Anvil manager; `@viem/anvil` is deprecated) against a **fork** of the chain hosting EAS, + a thin mock-provider tier for the EIP-1193 boundary.
- **Docs:** vocs guide + typedoc reference + a 5-minute quickstart.
- **Versioning:** keep Changesets; add a viem-style **`@efs/sdk/experimental`** entrypoint + `@deprecated` JSDoc discipline.
- **Bundle:** `size-limit` budgets in CI; `sideEffects:false`; ESM-first; Knip for dead exports. (`attw`+`publint` already in CI.)
- **No telemetry** (viem/wagmi don't phone home).
- **Framework:** reserve `@efs/react` (thin TanStack-Query wrapper) as a package boundary; build on demand.

## 2. Storage & durability — the mirror doctrine

- **Verify before trust, always** — hash full fetched bytes against `contentHash`, reject on mismatch. This is the whole security model and sidesteps CID≠sha256.
- **Multi-gateway, multi-mirror fallback** with per-attempt timeouts — **public IPFS gateways are being deprecated (2025)**; assume any single gateway is rate-limited, dead, or hostile.
- **Durability = pair a fast mirror** (IPFS pin via Storacha/Pinata/Filebase, or Filecoin-warm) **with a permanent one** (**Arweave** `ar://`). Surface a "durability = count of reachable, hash-verified mirrors" signal. Document that a hash alone is *not* a durability promise.
- **Transports:** `ipfs://`/`ar://`/`https://` ADOPT; `web3://` we own (standards.md); `walrus://`/EthStorage WATCH (seam-only); Swarm/Greenfield AVOID.
- **Content-type is adversarial** — `nosniff`, derive type ourselves, sandbox HTML/SVG; size limits + streaming hash; a range/partial read **cannot** be verified against a whole-file hash.

## 3. Indexing & read-scaling — index-first (see constraint #1)

- **Reverse-lookups stay caller-supplied** — the SDK bundles **no** indexer *and* wires **no** index provider into the client config. Document an `EfsIndexProvider` *shape* (`whoTagged`, `listWriters`, `versionsOf`) that callers implement, and ship a reference `EasGraphQLProvider` (over EAS's per-chain GraphQL endpoints) as a **docs/example adapter, not a bundled default or `index?` config seam**. Reserving such a seam would re-import the bundled-indexer framing that was explicitly stripped (sdk-architecture.md revision 2026-06-10 / Q3 2026-05-28); see the 2026-06-11 API review §F.
- **`eth_getLogs` is bounded-only** — chunked, recent-range, or one-time backfill; never the reverse-lookup backbone.
- **Multicall3** (`0xcA11…CA11`) for batched point-reads ("resolve N attestations").
- **Future:** shape the interface so **EIP-7745 verifiable logs** (Draft, Glamsterdam) can back it later — today's centralized-index pragmatism upgrades to trustless reads without an API break.
- **Event/indexability** lives in how we populate EAS's indexed `attester`/`schema`/`refUID` topics, not custom events.
- **Ship a reference subgraph + Envio/Ponder schema as docs** (not deps) so teams needing self-hosted/decentralized durability have a working starting point. Envio HyperIndex's wildcard indexing fits "index all EAS attestations of schema X" without enumerating addresses.

## 4. Security & clear-signing

- **ERC-7730 Clear Signing** (launched May 2026; Ledger/Trezor/MetaMask/WalletConnect) — **ADOPT: ship + maintain 7730 descriptors** for EFS's `attest`/`multiAttest` so users see path/contentHash/lens in plain text instead of blind-signing a hash. PR them to the clear-signing registry.
- **Never request `eth_sign`** (the Bybit-hack mechanism); EIP-712 typed data only. Never blind-sign.
- **Supply-chain:** keep OIDC Trusted Publishing + provenance; **pin exact dependency versions** (no `^`), commit lockfile, **minimize deps** (every dep is attack surface — the biggest lever for a wallet-adjacent SDK), `--ignore-scripts` in CI, `pnpm audit`/Socket.
- **Deployments registry is a trust root** — beyond the bytecode/UID check: provenance-attest + sign the generated registry, verify at load, make codegen reproducible. The only path to an address is generation+verification (no hand-edited JSON bypass).
- **Untrusted content is inert** — never execute fetched bytes, SSRF-guard mirror URLs (block private/loopback/metadata IPs), size/timeout limits, lens-scoped mirror filtering.
- **MEV/front-running** — path claims are front-runnable; **WATCH**, warn, and push commit-reveal at the contract layer if path-ownership lands (the SDK can't fix this alone).
- **Transaction simulation is a seam, not a dependency** — `efs.fs.preview` stays pluggable to a Tenderly/Blockaid-style simulation RPC (dry-run + asset-diff + malicious-contract scan), but bakes in **no** paid provider or API key. Simulation reflects current state and can drift at inclusion — never present "simulation passed" as a safety guarantee.

## 5. Gas & transaction lifecycle — durable shapes

- **EIP-5792 `getCallsStatus`** numeric status: `100` pending, `200` confirmed, `400` offchain-failed, `500` reverted, **`600` partial** — the dangerous one: a half-written file. Treat `600` as first-class with **resume/repair**, not a generic error.
- **`WriteEstimate`** should carry: per-call + total `gasUnits` (buffered), `chunkDeploys` (count+bytes), **`tokensInCalldata`** (EIP-7623 transparency), `maxFeePerGas`/`maxPriorityFeePerGas`, **`l1DataFee`** (L2 only — dominates, >90%; an L2-blind estimate under-reports by 10×), and `usd` as a **range** with `priceSource`+`asOf` (never a bare scalar; price provider is injected, Chainlink optional with staleness checks).
- **Nonce:** delegate to the wallet on the 5792 path; own gap-free sequential nonces + bump-retry only in the sequential fallback.
- **Finality:** expose a `confirmations` threshold; surface reorg via replacement reasons; own the poll cadence (5792 status retention is only 24h).

## 6. L2 / multi-chain / interop

- **Cross-chain reads** (read EFS on chain X while connected to Y) — **ADOPT now**: hold a read-only provider per supported chain, keyed by `chainId`, decoupled from the wallet chain. Highest-value multi-chain seam.
- **Per-chain address book is mandatory** — **EAS addresses differ per chain** (OP/Base share a predeploy; mainnet/Arbitrum don't). Ship `chainId → {efs, eas, schemaRegistry, schemaUIDs, transport}` as typed data.
- **CREATE2/CREATE3** deploy of EFS's *own* contracts → same address everywhere (collapses our half of the book).
- **Abstract the signer** so AA/EIP-7702/RIP-7560/intents drop in without touching resolution.
- **EIL / Superchain / ERC-7683 / ERC-7802** — **WATCH/AVOID**: they abstract *assets*, not *where data lives*; they won't relocate an EFS file. Don't architect around them.

## 7. Key management & the EFS-native key-set

- **Passkeys (RIP-7212) + MPC/embedded wallets are already covered** by our 1271/6492 verify path — the attester is the stable wallet address; key-share rotation doesn't change it. No new work.
- **No wallet standard does "many addresses → one identity."** Sub-accounts (ERC-7895) and session keys (ERC-7715) each get a *distinct* attester — the inverse of content attribution. So the **multi-device key-set is EFS-native**: a primary identity *attests* "these addresses are me" (the `webOfTrust` lens tier), *consuming* wallet hierarchies rather than replacing them.
- **Design in revocation/time-bounding** — "this device key is no longer me as of block N" — so a compromised device can't retroactively poison content. No standard gives this — but build it on **EAS-native primitives** (`expirationTime` uint64, `revocable`, `refUID`) rather than inventing parallel concepts.
- **Prefer stable smart-account addresses** over bare EOAs (EOA key loss = identity loss; smart-account recovery rotates the signer, not the address → attestations survive).

## 8. Metadata & representation

- **`contentType` = IANA media type** (+ optional `charset`), validated on write; the **attested** value is authoritative, never the transport's `Content-Type` or a file extension.
- **Minimal fixed-shape JSON manifest** per file (`name, description, contentType, size, created, author, contentHash`) — NFT-metadata-familiar, not overloaded.
- **Folders/lenses/lists self-describe** with a **Token-Lists-style envelope** (`name`, semver `version`, `timestamp`, `entries[]`) + ERC-7572 display fields so they render in existing dapp UIs.
- **Property keys: reverse-DNS** (`xyz.efs.*`) for third-party keys; a tiny reserved bare-key core (`contentType`/`contentHash`/`size`).
- **Serve path:** ERC-5219 status/headers + **ERC-7774 ETag/`evm-events` caching**; range as a seam. **JSON-LD/schema.org as an opt-in seam**, not the baseline (overkill).

## 9. Attestation substrate & encoding (completeness sweep)

The "what are we missing" sweep over attestation/registry/data standards — confirms we ride the right substrate and flags the emerging ones to track.

- **Ride EAS directly — there is no Final attestation ERC.** EAS is infrastructure, not a ratified ERC; `AttestationRequestData` (recipient, `expirationTime`, `revocable`, `refUID`, `bytes data`, value) is the contract we encode against. ERC-7512 (audits), ERC-5851 (verifiable credentials), ERC-8273 (agentic actions) are all Draft and off-target. **Keep an EAS-resolution seam** so a future attestation ERC could slot in without client churn, but don't wait for one.
- **EAS-native time/revocation** — use `expirationTime`/`revocable`/`refUID` for mirrors, transports, versioning, and key-set revocation rather than parallel concepts (ties to §7).
- **EIP-712 domain is obtained at runtime, never hardcoded** — fetch it from the deployed verifier's `getDomainSeparator()` (which binds `name`+`version`+`chainId`+`verifyingContract`) for every delegated/offchain EAS request. The observed `name "EAS"` / `version "1.4.0"` (eas-contracts master) is a **sanity check only** — both vary by deployment. Do **not** assume EIP-5267 `eip712Domain()` is callable (absent in master). Domain mismatch is the #1 EIP-712 failure mode (see [standards.md](./standards.md) EIP-712 row).
- **ERC-8048 / ERC-8049** — onchain key-value metadata with indexed-key events; the **closest emerging mirror of EFS PROPERTYs**. **WATCH closely** — design properties so they're expressible through that shape. (ERC-7208 data-containers / ERC-7813 table-storage are looser parallels — lower-priority WATCH.)
- **ERC-2098 compact signatures (64-byte)** — EAS delegated/offchain paths may hand us compact sigs; the verify/normalize seam should **accept both 64- and 65-byte forms**. This is **TS-verification-scoped only** — an off-chain normalization concern, not an on-chain `@efs/solidity` one.
- **`abi.encode`, never `encodePacked`** for anything hashed/signed (collision-safety); **EIP-1559 fee fields** via `feeHistory` + buffered estimate, exposed as a per-batch override seam. (Both already in [standards.md](./standards.md) AVOID/ADOPT.)

## 10. Roadmap watch list (re-check ~quarterly)

| Item | Timeline | Why we care |
|---|---|---|
| **Rolling history expiry (EIP-4444)** | active, ~1yr rollout | **Highest risk** — index-first reads (constraint #1). |
| **Glamsterdam** (ePBS, BALs, **EIP-7904 gas repricing**) | H1 2026 | Re-benchmark storage/write costs after it lands. |
| **EIP-7745/7792 verifiable logs** | Draft, Glamsterdam | The trustless upgrade path for our index provider. |
| **State expiry** | research, years out | The one item that could touch *live* attestation reads — standing watch. |
| **ERC-7730 V2**, ERC-7572/7774/7895/7715 | Draft/moving | Adopt shapes now, treat wire formats as moving (SEAM). |
| **Native AA (RIP-7560)** | L2, no L1 date | Keep the signer abstracted. |

## AVOID
`eth_sign`/blind-signing · `web3.js` · `^`-ranged deps for a wallet SDK · `SELFDESTRUCT`+CREATE2 redeploy tricks (EIP-6780) · self-rolled MPT storage proofs (state-tree migration coming) · EIP-4844 blobs for durable content · genesis-to-head `getLogs` at runtime · depending on specific opcode/precompile gas costs (repricing forks).
