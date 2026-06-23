/**
 * `SnapshotReadSource` — an OFFLINE {@link ReadSource} that serves prefetched records with NO
 * node and NO live chain (ADR-0014). The target use is the production client's offline mode:
 * read cached attestations + file bytes captured at a known block.
 *
 * **Reserved stub.** The shape (a `ReadSnapshot` of decoded `readContract` returns keyed by a
 * canonical call key, plus captured bytecode/ENS) is fixed here so the surface is stable and
 * visible to future work; the lookup/recorder and the call-key canonicalization are a later
 * additive slice (today `readContract` throws `NotImplemented`). Critically `authoritative`
 * is `false`: a snapshot can prove UID self-consistency + content-hash offline, but NOT
 * on-chain existence/revocation — the trust descriptor (ADR-0015) reflects that.
 */

import type { Address, Hex } from 'viem'
import { NotImplemented } from '../../errors.js'
import type { ReadSource } from '../source.js'

/** A point-in-time capture: decoded `readContract` returns keyed by a canonical call key,
 * plus optional captured bytecode (for web3:// SSTORE2 replay) and ENS resolutions. */
export type ReadSnapshot = {
  readonly chainId: number
  /** The block the capture was taken at (stamped into trust as `revocation: as-of`). */
  readonly block: bigint
  /** Wall-clock capture time (epoch seconds). */
  readonly asOf: number
  /** Canonical-call-key → decoded return. */
  readonly records: Record<string, unknown>
  /** Captured bytecode by address (web3:// SSTORE2 replay). Absent ⇒ `supportsGetCode:false`. */
  readonly code?: Record<Address, Hex>
  /** Captured ENS resolutions. Absent ⇒ `supportsEns:false`. */
  readonly ens?: Record<string, Address>
}

/**
 * Construct an offline {@link ReadSource} over a {@link ReadSnapshot}. RESERVED — the read
 * lookup is a later additive slice; today it throws `NotImplemented`. The `capabilities`
 * and `chainId` are honest now so callers can already branch on a snapshot source.
 */
export function snapshotReadSource(snap: ReadSnapshot): ReadSource {
  return {
    chainId: snap.chainId,
    readContract: async () => {
      throw new NotImplemented('SnapshotReadSource.readContract', {
        alternative:
          'the offline snapshot read path is a later slice — use a ViemReadSource (live) for now.',
      })
    },
    ...(snap.code ? { getCode: async () => undefined } : {}),
    capabilities: {
      kind: 'snapshot',
      authoritative: false, // ← cannot confirm existence/revocation offline (ADR-0015)
      supportsGetCode: Boolean(snap.code),
      supportsEns: Boolean(snap.ens),
      readContract: 'known-subset',
      supportsRangeQueries: false,
      snapshotBlock: snap.block,
      snapshotAsOf: snap.asOf,
    },
  }
}
