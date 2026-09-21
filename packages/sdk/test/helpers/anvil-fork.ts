/**
 * prool-based Anvil fork harness (scaffold).
 *
 * `@viem/anvil` is deprecated in favour of `prool` (wevm), so the fork harness
 * is built on prool's `anvil` instance. Fork tests are **opt-in**: they require
 * a real upstream RPC to fork from and a local `anvil` binary (Foundry), neither
 * of which exists in networkless CI. They are gated behind `EFS_FORK_RPC_URL`
 * and SKIP by default.
 *
 * Run locally with Foundry installed:
 *
 *   EFS_FORK_RPC_URL="https://sepolia.infura.io/v3/<key>" pnpm --filter @efs/sdk test
 *
 * prool is loaded via dynamic import inside {@link startAnvilFork} so that
 * merely collecting the test file never imports it — prool requires Node >=22
 * while CI runs Node 20, and the import must not run unless a fork test does.
 */

import type { Address } from 'viem'

/** The upstream RPC to fork from, or `undefined` when fork tests are disabled. */
export const FORK_RPC_URL: string | undefined = process.env.EFS_FORK_RPC_URL || undefined

/** Whether the env opts into fork tests. Use to `describe.skipIf(!forkEnabled())`. */
export function forkEnabled(): boolean {
  return Boolean(FORK_RPC_URL)
}

/**
 * Canonical EAS deployment address to assert bytecode for. Defaults to the EAS
 * on Sepolia (the SDK's first target chain); override via `EFS_FORK_EAS_ADDRESS`
 * when forking a different chain (e.g. mainnet EAS).
 */
export const FORK_EAS_ADDRESS = (process.env.EFS_FORK_EAS_ADDRESS ??
  '0xC2679fBD37d54388Ce493F1DB75320D236e1815e') as Address

export type AnvilFork = {
  /** The JSON-RPC URL of the forked node. */
  rpcUrl: string
  /** Stop the node and free the port. */
  stop: () => Promise<void>
}

/**
 * Start an Anvil instance forking {@link FORK_RPC_URL}. Throws if fork tests are
 * not enabled — callers must gate with {@link forkEnabled} first. Loads prool
 * dynamically so the dependency is only touched when a fork test actually runs.
 */
export async function startAnvilFork(): Promise<AnvilFork> {
  if (!FORK_RPC_URL) {
    throw new Error('startAnvilFork() called without EFS_FORK_RPC_URL set')
  }
  const { anvil } = await import('prool/instances')
  const instance = anvil({ forkUrl: FORK_RPC_URL })
  const stop = await instance.start()
  const rpcUrl = `http://${instance.host}:${instance.port}`
  return {
    rpcUrl,
    stop: async () => {
      await stop()
    },
  }
}
