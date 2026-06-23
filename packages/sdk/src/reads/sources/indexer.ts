/**
 * `IndexerReadSource` — a {@link ReadSource} backed by a caller-supplied indexer
 * (GraphQL/SQL) for reads that live RPC can't serve at scale (reverse lookups, large
 * directory pages, time-series) — ADR-0014.
 *
 * **Reserved stub.** Consistent with the standing "no bundled indexer; a caller-supplied
 * source, not an `index?` config" stance: the SDK ships the *shape*, not an indexer. A real
 * impl translates the ~12 frozen view functions (`getFilesAtPath`, `getDirectoryPage*`,
 * `getDataMirrors`, `resolveAnchor`, `getActivePinTarget`, `getAttestation`, …) into the
 * indexer's query language, synthesising the ABI-shaped return so the existing verbs decode
 * it unchanged. Today `readContract` throws `NotImplemented`.
 *
 * `authoritative: false` — an indexer LAGS chain head, so revocation freshness is `as-of` its
 * head, never `live` (ADR-0015). `supportsGetCode: false` — it has no EVM, so web3:// byte
 * reads need a live source; point reads route to a node, list/range reads to the indexer (a
 * composable router is a later slice).
 */

import { NotImplemented } from '../../errors.js'
import type { ReadSource } from '../source.js'

/** Configuration for an {@link IndexerReadSource} (caller-supplied endpoint + the chain it
 * indexes, carried as data). */
export type IndexerConfig = {
  readonly chainId: number
  /** The indexer endpoint (GraphQL/SQL gateway). */
  readonly url: string
}

/**
 * Construct an indexer-backed {@link ReadSource}. RESERVED — the view-function translation
 * is a later additive slice; today every read throws `NotImplemented`. Capabilities are
 * honest now (lagging, no EVM, range-capable) so callers can branch.
 */
export function indexerReadSource(cfg: IndexerConfig): ReadSource {
  return {
    chainId: cfg.chainId,
    readContract: async (a) => {
      throw new NotImplemented(`IndexerReadSource.readContract(${a.functionName})`, {
        alternative:
          'the indexer read path is a later slice — use a ViemReadSource (live) for now.',
      })
    },
    capabilities: {
      kind: 'indexer',
      authoritative: false, // an indexer lags head — revocation freshness is `as-of`, not `live`
      supportsGetCode: false, // no EVM — web3:// byte reads need a live source
      supportsEns: false,
      readContract: 'known-subset',
      supportsRangeQueries: true, // richer than a node for list/range (the reason to use one)
    },
  }
}
