/**
 * Shared active-mirror scanner over `EFSFileView.getDataMirrors`, used by the
 * byte-fetch path (`reads/fetch.ts`) and `efs.mirrors.list`.
 *
 * WINDOW SEMANTICS (EFSIndexer._sliceUIDsFiltered): the view slices the
 * indexer's RAW referencing array and filters revoked entries WITHIN each
 * physical window — a window returns `<= length` rows and never scans past
 * itself to fill. So a short (or even empty) window is NOT exhaustion, and a
 * `start` at/past the raw end REVERTS (`InvalidOffset`). The raw count is the
 * only correct pagination bound: read it first, then walk disjoint physical
 * windows. Anything else either drops every active mirror behind a revoked
 * slot (r3740924418) or sends a reverting extra read when the raw count is an
 * exact multiple of the page size.
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { getReferencingBySchemaAndAttesterCountAbi } from '../chain/abi/indexer.js'
import { type ReadContext, read } from './context.js'

/** How many mirrors to read per `getDataMirrors` window. */
export const MIRROR_PAGE = 50
/** Hard cap on mirror rows scanned (matches the router's 500-row ceiling). */
export const MAX_MIRRORS = 500

/** One row as returned by `getDataMirrors`. */
export type MirrorRow = {
  uid: Hex
  transportDefinition: Hex
  uri: string
  attester: Address
  timestamp: bigint
}

/** All ACTIVE mirror rows for `(dataUID, attester)`, complete up to
 * {@link MAX_MIRRORS} raw slots — revoked holes never truncate the scan. */
export async function scanActiveMirrors(
  publicClient: ReadContext['publicClient'],
  dep: { contracts: { fileView: Address; indexer: Address }; schemas: { mirror: Hex } },
  dataUID: Hex,
  attester: Address,
): Promise<MirrorRow[]> {
  const raw = await read<bigint>(publicClient, {
    address: dep.contracts.indexer,
    abi: getReferencingBySchemaAndAttesterCountAbi,
    functionName: 'getReferencingBySchemaAndAttesterCount',
    args: [dataUID, dep.schemas.mirror, attester],
  })
  const total = Math.min(Number(raw), MAX_MIRRORS)
  const out: MirrorRow[] = []
  for (let start = 0; start < total; start += MIRROR_PAGE) {
    // The contract clamps a window running past the raw end — only `start`
    // itself must stay under the raw count (the loop bound guarantees it).
    const rows = await read<readonly MirrorRow[]>(publicClient, {
      address: dep.contracts.fileView,
      abi: fileViewAbi,
      functionName: 'getDataMirrors',
      args: [dataUID, attester, BigInt(start), BigInt(MIRROR_PAGE)],
    })
    out.push(...rows)
  }
  return out
}
