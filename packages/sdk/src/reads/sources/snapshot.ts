/**
 * `SnapshotReadSource` — an OFFLINE {@link ReadSource} that serves prefetched records with NO
 * node and NO live chain (ADR-0014). The target use is the production client's offline mode:
 * read cached attestations + file bytes captured at a known block.
 *
 * **Reserved stub.** The shape (a `ReadSnapshot` of decoded `readContract` returns keyed by a
 * canonical call key, plus captured bytecode/ENS) is fixed here so the surface is stable and
 * visible to future work; the lookup/recorder and the call-key canonicalization are a later
 * additive slice (today `readContract` throws `NotImplemented`). Critically `state` is
 * `'pinned'`: a snapshot can prove UID self-consistency + content-hash offline, but NOT
 * on-chain existence/revocation — the trust descriptor (ADR-0015) derives `as-of` the
 * capture's {@link ReadBasis} from that, never `current`.
 */

import type { Address, Hex } from 'viem'
import { NotImplemented } from '../../errors.js'
import type { ReadSource } from '../source.js'

/** A point-in-time capture: decoded `readContract` returns keyed by a canonical call key,
 * plus optional captured bytecode (for web3:// SSTORE2 replay) and ENS resolutions. */
export type ReadSnapshot = {
  readonly chainId: number
  /** The block the capture was taken at (stamped into the trust descriptor as
   * `freshness: 'as-of'` with this basis). */
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
 *
 * Capability metadata describes CALLABLE behavior, not stored snapshot contents:
 * until the lookup slice lands, `getCode`/`getEnsAddress` do not exist on this
 * source (an ABSENT method is the honest no-capability signal — a present
 * `getCode` answering `undefined` would assert "no bytecode at this address", a
 * WRONG answer the web3:// reader would trust), and `supportsGetCode`/
 * `supportsEns` are hard `false` regardless of what the snapshot captured.
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
    capabilities: {
      kind: 'snapshot',
      state: 'pinned', // ← cannot confirm existence/revocation offline (ADR-0015)
      pinnedBasis: { chainId: snap.chainId, blockNumber: snap.block, asOf: snap.asOf },
      // LOAD-BEARING flip note: these become `Boolean(snap.code)` / `Boolean(snap.ens)`
      // when the lookup slice actually wires the methods — until then any code
      // branching on snapshot capabilities must see all snapshots as codeless/ENS-less.
      supportsGetCode: false,
      supportsEns: false,
      readContract: 'known-subset',
      supportsRangeQueries: false,
    },
  }
}
