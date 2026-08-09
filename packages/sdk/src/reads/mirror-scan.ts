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
import {
  getReferencingBySchemaAndAttesterAbi,
  getReferencingBySchemaAndAttesterCountAbi,
} from '../chain/abi/indexer.js'
import { type ReadContext, read } from './context.js'

/** The read surface the mirror scans need — the submit path holds a wider
 * client type, so it casts to this rather than the whole {@link ReadContext}. */
export type MirrorScanClient = ReadContext['publicClient']

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

/**
 * Whether `attester` holds at least ONE active mirror on `dataUID` — the
 * READABILITY predicate every write gate asks before minting a placement,
 * symlink or hardlink that would otherwise confirm and then fail every read
 * with `AllMirrorsFailed`.
 *
 * Shared deliberately (r3742238093): this check had been re-derived at five
 * call sites, and the copies drifted — some kept scanning raw slots `[0, 500)`
 * after {@link scanActiveMirrors} moved to the newest-{@link MAX_MIRRORS}
 * window, so a gate could refuse a file the reader and the router can both
 * serve. A gate that disagrees with the reader is worse than no gate.
 *
 * Cheaper than {@link scanActiveMirrors}: reads UIDs (not decoded rows) and
 * exits on the first active hit, so the healthy case costs one count read plus
 * one window.
 */
export async function hasActiveMirror(
  publicClient: ReadContext['publicClient'],
  where: { indexer: Address; mirrorSchema: Hex },
  dataUID: Hex,
  attester: Address,
): Promise<boolean> {
  const raw = Number(
    await read<bigint>(publicClient, {
      address: where.indexer,
      abi: getReferencingBySchemaAndAttesterCountAbi,
      functionName: 'getReferencingBySchemaAndAttesterCount',
      args: [dataUID, where.mirrorSchema, attester],
    }),
  )
  for (let start = mirrorWindowStart(raw); start < raw; start += MIRROR_PAGE) {
    const page = await read<readonly Hex[]>(publicClient, {
      address: where.indexer,
      abi: getReferencingBySchemaAndAttesterAbi,
      functionName: 'getReferencingBySchemaAndAttester',
      // (data, MIRROR, attester, start, len, reverseOrder=false, showRevoked=false)
      args: [
        dataUID,
        where.mirrorSchema,
        attester,
        BigInt(start),
        BigInt(MIRROR_PAGE),
        false,
        false,
      ],
    })
    if (page.length > 0) return true
  }
  return false
}
