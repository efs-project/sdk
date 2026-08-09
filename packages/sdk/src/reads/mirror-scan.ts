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
 *
 * WHICH 500 (r3742144271): the raw array is append-only — revoking a mirror
 * does NOT free its slot — so past {@link MAX_MIRRORS} raw records the ceiling
 * decides which mirrors are visible at all. `EFSRouter._bestMirrorUri` caps at
 * the same 500 but walks `reverseOrder = true`, i.e. it reads the NEWEST 500
 * raw slots. Scanning from offset 0 would therefore pin us to the OLDEST 500 —
 * the SDK would report `AllMirrorsFailed` on a DATA the router happily serves,
 * and every mirror added after the 500th would be invisible to us forever
 * despite a confirmed receipt. So the window is anchored to the END of the raw
 * array ({@link mirrorWindowStart}), selecting the same set the router does.
 * `EFSFileView.getDataMirrors` hardcodes `reverseOrder = false`, so we pick the
 * offsets rather than the direction; rows stay oldest-first WITHIN the window.
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import { getReferencingBySchemaAndAttesterCountAbi } from '../chain/abi/indexer.js'
import { type ReadContext, read } from './context.js'

/** How many mirrors to read per `getDataMirrors` window. */
export const MIRROR_PAGE = 50
/** Hard cap on mirror rows scanned (matches the router's 500-row ceiling). */
export const MAX_MIRRORS = 500

/** The first physical offset of the scan window over a `raw`-slot array: the
 * LAST {@link MAX_MIRRORS} slots, so a newly appended mirror is always in view
 * (see the module note). `0` whenever the whole array fits. */
export function mirrorWindowStart(raw: number): number {
  return raw > MAX_MIRRORS ? raw - MAX_MIRRORS : 0
}

/** One row as returned by `getDataMirrors`. */
export type MirrorRow = {
  uid: Hex
  transportDefinition: Hex
  uri: string
  attester: Address
  timestamp: bigint
}

/** All ACTIVE mirror rows for `(dataUID, attester)` within the newest
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
  const total = Number(raw)
  const out: MirrorRow[] = []
  for (let start = mirrorWindowStart(total); start < total; start += MIRROR_PAGE) {
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
