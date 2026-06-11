/**
 * Fork tests (opt-in). These spin a real Anvil fork via prool and talk to it
 * with viem. They SKIP unless `EFS_FORK_RPC_URL` is set and a local `anvil`
 * binary (Foundry) is available — networkless CI never runs them.
 *
 *   EFS_FORK_RPC_URL="https://sepolia.infura.io/v3/<key>" pnpm --filter @efs/sdk test
 *
 * This is scaffold only: a single smoke test that the EAS contract has bytecode
 * on the forked chain. On-chain EFS logic tests are deferred until the schema
 * freeze lands (see future-proofing.md §1).
 */

import { http, createPublicClient } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AnvilFork,
  FORK_EAS_ADDRESS,
  forkEnabled,
  startAnvilFork,
} from './helpers/anvil-fork.js'

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
