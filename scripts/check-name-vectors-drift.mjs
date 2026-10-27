#!/usr/bin/env node
/**
 * Anchor-name vector drift check.
 *
 * The v1 canonical anchor-name encoding (contracts specs/02) is implemented three
 * times: EFSIndexer (write-time validation), EFSRouter (re-encoding web3:// path
 * segments) and this SDK's `encodeName`. One shared vector file keeps them
 * byte-aligned. The canonical copy lives in the contracts repo, next to the spec;
 * this repo keeps a byte-identical copy. Two copies with nothing comparing them
 * would let either side drift while both suites stay green, so this fails when
 * the local copy differs from contracts `main`.
 *
 * To fix a red run: copy the contracts file over the local one, then run the SDK
 * suite — a vector change usually means `names/segment.ts` must change too.
 *
 * Network-hard-fail by design (same as check-deployment-drift.mjs): a fetch error
 * is a red run, not a skip.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM_PATH = 'packages/hardhat/test/fixtures/anchor-names.vectors.json'
const UPSTREAM = `https://raw.githubusercontent.com/efs-project/contracts/main/${UPSTREAM_PATH}`
const LOCAL = join(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/sdk/test/fixtures/anchor-names.vectors.json',
)

const res = await fetch(UPSTREAM)
if (!res.ok) {
  console.error(`✖ fetch ${UPSTREAM}: HTTP ${res.status}`)
  process.exit(1)
}
const upstream = await res.text()
const local = readFileSync(LOCAL, 'utf8')

if (upstream === local) {
  console.log('✓ anchor-name vectors match efs-project/contracts main')
  process.exit(0)
}

const up = upstream.split('\n')
const lo = local.split('\n')
const first = up.findIndex((line, i) => line !== lo[i])
const at = first === -1 ? Math.min(up.length, lo.length) : first
console.error('✖ anchor-name vectors differ from efs-project/contracts main.')
console.error(`  first difference at line ${at + 1}:`)
console.error(`    contracts: ${up[at] ?? '(end of file)'}`)
console.error(`    sdk:       ${lo[at] ?? '(end of file)'}`)
console.error(`  Canonical copy: efs-project/contracts ${UPSTREAM_PATH}`)
console.error(
  '  Copy it over packages/sdk/test/fixtures/anchor-names.vectors.json and rerun the SDK tests.',
)
process.exit(1)
