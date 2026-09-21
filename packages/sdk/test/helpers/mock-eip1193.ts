/**
 * A tiny, dependency-free EIP-1193 provider fake for unit tests.
 *
 * Real wallets (MetaMask, WalletConnect, Coinbase, embedded) are all EIP-1193
 * providers — an object with `request({ method, params })`. The SDK's boundary
 * is that interface (ADR-0009): `createEfsClient({ provider, chain })` wraps it
 * with viem's `custom()` transport. This helper lets a test drive that boundary
 * without a network or a browser wallet.
 *
 * It answers the handful of JSON-RPC methods the freeze-independent client paths
 * touch — `eth_chainId`, `eth_getCode`, `eth_call`, `web3_clientVersion`,
 * `eth_blockNumber` — and records every call for assertions. Per-method handlers
 * can be overridden, and any unhandled method rejects (so a test notices an
 * unexpected RPC) unless a `fallback` is supplied.
 */

import type { EIP1193Provider } from 'viem'

/** One recorded JSON-RPC request. */
export type RecordedCall = { method: string; params: readonly unknown[] }

/** A per-method handler: receives the params, returns the raw RPC result. */
export type MethodHandler = (params: readonly unknown[]) => unknown | Promise<unknown>

export type MockProviderOptions = {
  /**
   * The chain id the provider reports for `eth_chainId` (hex-encoded on the
   * wire). Defaults to 31337 (the common local/anvil id).
   */
  chainId?: number
  /**
   * Bytecode returned by `eth_getCode`, keyed by lowercased address. A bare
   * string sets the default for every address. Defaults to `'0x'` (no code).
   */
  code?: string | Record<string, string>
  /** Explicit per-method overrides; take precedence over the built-ins. */
  handlers?: Record<string, MethodHandler>
  /** Called for any method with no handler. Without it, unknown methods reject. */
  fallback?: MethodHandler
}

/** A mock provider plus the bits a test wants to inspect. */
export type MockProvider = EIP1193Provider & {
  /** Every `request` made, in order. */
  readonly calls: RecordedCall[]
  /** Count of calls for a given method. */
  callCount(method: string): number
}

function toHex(n: number): `0x${string}` {
  return `0x${n.toString(16)}`
}

function codeFor(code: MockProviderOptions['code'], address: string): string {
  if (code === undefined) return '0x'
  if (typeof code === 'string') return code
  return code[address.toLowerCase()] ?? '0x'
}

/**
 * Build a minimal EIP-1193 provider fake. Pass `chainId`, `code`, per-method
 * `handlers`, or a `fallback`. Every request is recorded on `.calls`.
 */
export function createMockProvider(opts: MockProviderOptions = {}): MockProvider {
  const chainId = opts.chainId ?? 31337
  const calls: RecordedCall[] = []

  const builtins: Record<string, MethodHandler> = {
    eth_chainId: () => toHex(chainId),
    net_version: () => String(chainId),
    web3_clientVersion: () => 'efs-mock/1.0.0',
    eth_blockNumber: () => '0x1',
    eth_getCode: (params) => codeFor(opts.code, String(params[0] ?? '')),
    eth_call: () => '0x',
  }

  const request = async ({
    method,
    params,
  }: {
    method: string
    params?: readonly unknown[]
  }): Promise<unknown> => {
    const p = (params ?? []) as readonly unknown[]
    calls.push({ method, params: p })
    const handler = opts.handlers?.[method] ?? builtins[method] ?? opts.fallback
    if (!handler) {
      throw new Error(`mock EIP-1193 provider: unhandled method "${method}"`)
    }
    return handler(p)
  }

  // EIP-1193 also specifies an event emitter surface; the SDK doesn't subscribe
  // in these paths, so no-op listeners are enough to satisfy the type.
  const provider = {
    request,
    on: () => provider,
    removeListener: () => provider,
  } as unknown as MockProvider

  Object.defineProperty(provider, 'calls', { get: () => calls })
  Object.defineProperty(provider, 'callCount', {
    value: (method: string) => calls.filter((c) => c.method === method).length,
  })

  return provider
}
