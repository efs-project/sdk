#!/usr/bin/env node
/**
 * Deployment-record drift check (interim gate — ADR-0018).
 *
 * Compares the SDK's built-in Sepolia registry against the contracts repo's
 * canonical record at `main`:
 *   1. the hardhat deployment artifacts (`packages/hardhat/deployments/sepolia/<C>.json`)
 *   2. the `docs/CHAINS.md` address + frozen-UID tables
 *
 * Three DISTINCT failure modes, so a red run says exactly what drifted:
 *   - registry ≠ artifacts        → the SDK is stale (the June-23 view-drift class)
 *   - registry ≠ CHAINS.md        → same, caught via the doc record
 *   - artifacts ≠ CHAINS.md       → UPSTREAM records conflict (the contracts#43
 *                                   scenario) — do not silently pick one; fail
 *                                   and coordinate upstream.
 *
 * The devnet is deliberately NOT checked against Sepolia records (independent-
 * profile principle, contracts#43 acceptance criteria). DELETE this script and
 * consume the generated manifest when efs-project/contracts#43 lands.
 *
 * Network-hard-fail by design: a fetch error is a red run, not a skip — a
 * silently-skipped drift gate is how drift ships.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAW = 'https://raw.githubusercontent.com/efs-project/contracts/main'

// artifact name ↔ SDK registry key
const CONTRACT_KEYS = {
  Indexer: 'indexer',
  EFSRouter: 'router',
  EFSFileView: 'fileView',
  EdgeResolver: 'edgeResolver',
  MirrorResolver: 'mirrorResolver',
  ListResolver: 'listResolver',
  ListEntryResolver: 'listEntryResolver',
  ListReader: 'listReader',
  AliasResolver: 'aliasResolver',
  SystemAccount: 'systemAccount',
}

// CHAINS.md schema table label ↔ SDK schemas key
const SCHEMA_KEYS = {
  ANCHOR: 'anchor',
  PROPERTY: 'property',
  DATA: 'data',
  PIN: 'pin',
  TAG: 'tag',
  MIRROR: 'mirror',
  LIST: 'list',
  LIST_ENTRY: 'listEntry',
  REDIRECT: 'redirect',
}

/** Extract the built-in SEPOLIA record from the registry SOURCE (no build needed). */
function loadRegistry() {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '../packages/sdk/src/chain/deployments.ts'), 'utf8')
  const sepolia = src.slice(src.indexOf('export const SEPOLIA'))
  const section = sepolia.slice(0, sepolia.indexOf('\n}\n'))
  const contracts = {}
  const schemas = {}
  const contractsBlock = section.slice(section.indexOf('contracts:'), section.indexOf('views:'))
  const schemasBlock = section.slice(section.indexOf('schemas:'))
  for (const [, key, addr] of contractsBlock.matchAll(/(\w+):\s*'(0x[0-9a-fA-F]{40})'/g)) {
    contracts[key] = addr
  }
  for (const [, key, uidHex] of schemasBlock.matchAll(/(\w+):\s*'(0x[0-9a-fA-F]{64})'/g)) {
    schemas[key] = uidHex
  }
  return { contracts, schemas }
}

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`)
  return res.text()
}

/** Parse the CHAINS.md Sepolia pipe-tables into { name → 0x… } maps. Minimal on
 * purpose (rows only) — the fragile leg; the artifact JSON is the robust one. */
function parseChains(md) {
  const addresses = {}
  const uids = {}
  for (const [, label, hex] of md.matchAll(/\|\s*([^|]+?)\s*\|\s*`(0x[0-9a-fA-F]{40})`\s*\|/g)) {
    addresses[label.trim()] = hex
  }
  for (const [, label, hex] of md.matchAll(/\|\s*([A-Z_]+)\s*\|\s*`(0x[0-9a-fA-F]{64})`\s*\|/g)) {
    uids[label.trim()] = hex
  }
  return { addresses, uids }
}

/** CHAINS.md row label per artifact name (the doc uses descriptive labels). */
const CHAINS_LABELS = {
  Indexer: 'EFSIndexer (kernel)',
  EFSRouter: 'EFSRouter',
  EFSFileView: 'EFSFileView',
  EdgeResolver: 'EdgeResolver (PIN/TAG)',
  MirrorResolver: 'MirrorResolver (MIRROR)',
  ListResolver: 'ListResolver (LIST)',
  ListEntryResolver: 'ListEntryResolver (LIST_ENTRY)',
  AliasResolver: 'AliasResolver (REDIRECT)',
  ListReader: 'ListReader',
  SystemAccount: 'SystemAccount (`system` lens)',
}

const eq = (a, b) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()

const registry = loadRegistry()
const failures = { registryVsArtifacts: [], registryVsChains: [], upstreamConflict: [] }

// 1. Artifacts.
const artifacts = {}
for (const name of Object.keys(CONTRACT_KEYS)) {
  const json = JSON.parse(
    await fetchText(`${RAW}/packages/hardhat/deployments/sepolia/${name}.json`),
  )
  artifacts[name] = json.address
}

// 2. CHAINS.md.
const chains = parseChains(await fetchText(`${RAW}/docs/CHAINS.md`))

for (const [name, key] of Object.entries(CONTRACT_KEYS)) {
  const reg = registry.contracts[key]
  const art = artifacts[name]
  const doc = chains.addresses[CHAINS_LABELS[name]]
  if (!eq(art, doc)) {
    failures.upstreamConflict.push(`${name}: artifact ${art} vs CHAINS.md ${doc ?? '(missing)'}`)
    continue // don't cascade a pick — upstream must reconcile first
  }
  if (!eq(reg, art)) failures.registryVsArtifacts.push(`${key}: registry ${reg} vs artifact ${art}`)
  if (!eq(reg, doc)) failures.registryVsChains.push(`${key}: registry ${reg} vs CHAINS.md ${doc}`)
}

for (const [label, key] of Object.entries(SCHEMA_KEYS)) {
  const reg = registry.schemas[key]
  const doc = chains.uids[label]
  if (!eq(reg, doc)) {
    failures.registryVsChains.push(
      `schema ${key}: registry ${reg} vs CHAINS.md ${doc ?? '(missing)'}`,
    )
  }
}

let failed = false
if (failures.upstreamConflict.length > 0) {
  failed = true
  console.error(
    '✖ UPSTREAM RECORDS CONFLICT (artifacts ≠ CHAINS.md) — do not silently pick one; reconcile in efs-project/contracts (see issue #43):',
  )
  for (const f of failures.upstreamConflict) console.error(`  - ${f}`)
}
if (failures.registryVsArtifacts.length > 0) {
  failed = true
  console.error('✖ SDK registry ≠ contracts deployment artifacts:')
  for (const f of failures.registryVsArtifacts) console.error(`  - ${f}`)
}
if (failures.registryVsChains.length > 0) {
  failed = true
  console.error('✖ SDK registry ≠ contracts docs/CHAINS.md:')
  for (const f of failures.registryVsChains) console.error(`  - ${f}`)
}
if (failed) process.exit(1)
console.log('✓ deployment registry matches the contracts record (artifacts + CHAINS.md agree)')
