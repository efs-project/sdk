/**
 * `ViemReadSource` — the LIVE {@link ReadSource} adapter wrapping a viem `PublicClient`
 * (ADR-0014). This is today's behavior made explicit: it is the only implemented source, and
 * the construction path's existing `publicClient as ReadContext['publicClient']` cast becomes
 * a typed constructor.
 *
 * `authoritative: true` — a live node reads current chain state, so existence and revocation
 * are observable (the trust descriptor stamps `live` from this). `chainId` is supplied
 * explicitly (chain-as-data) when the client is chainless; otherwise it falls back to the
 * bound `client.chain.id`.
 */

import type { Address, Hex, PublicClient } from 'viem'
import { EfsError } from '../../errors.js'
import type { ReadSource } from '../source.js'

/**
 * Wrap a viem `PublicClient` as a live {@link ReadSource}. `opts.chainId` supplies the
 * deployment chain as data for a chainless client (`createPublicClient({ transport })`);
 * when omitted it falls back to the bound `client.chain?.id`, throwing if neither is present
 * (a write-capable client genuinely needs a synchronous chain anchor — ADR-0014).
 */
export function viemReadSource(client: PublicClient, opts?: { chainId?: number }): ReadSource {
  const chainId = opts?.chainId ?? client.chain?.id
  if (chainId === undefined) {
    throw new EfsError(
      'viemReadSource: the supplied `publicClient` has no bound `chain` and no `chainId` was provided — cannot resolve the EFS deployment. Pass `{ chainId }`, or construct the client with a chain.',
      { code: 'InvalidArgument' },
    )
  }
  return {
    chainId,
    readContract: (a) => client.readContract(a as Parameters<PublicClient['readContract']>[0]),
    getCode: (a: { address: Address }) => client.getCode(a) as Promise<Hex | undefined>,
    getEnsAddress: (a: { name: string }) => client.getEnsAddress(a),
    getChainId: () => client.getChainId(),
    capabilities: {
      kind: 'live',
      authoritative: true,
      supportsGetCode: true,
      supportsEns: true,
      readContract: 'arbitrary',
      supportsRangeQueries: true,
    },
  }
}
