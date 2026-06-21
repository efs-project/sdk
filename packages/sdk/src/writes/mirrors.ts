/**
 * `efs.mirrors.*` — the standalone **MIRROR** retrieval-method primitive
 * (add / remove / list). Completes write parity: `fs.write` already publishes
 * MIRRORs inline (the web3:// on-chain mirror, plus any caller `opts.mirrors`),
 * but there was no way to add a retrieval method to an EXISTING DATA after the fact.
 *
 * A MIRROR is a cardinality-N edge `MIRROR(refUID = dataUID, data =
 * (transportDefinition, uri))` from the connected attester (MirrorResolver.sol;
 * ADR-0011/0015). It is the SAME attestation shape the file-write DAG emits inline
 * for a file's retrieval methods — here exposed as a standalone verb that authors
 * exactly one MIRROR on an existing DATA.
 *
 *  - `add(dataUID, { uri, transport? })` → {@link WriteReceipt} — publish one MIRROR
 *    (ONE signature). The transport anchor is resolved up front (see
 *    {@link resolveMirrorTransport}): an explicit `transport` UID wins, else it is
 *    derived from the URI's scheme. MIRROR is NOT cardinality-1 (ADR-0015) — `add`
 *    never supersedes a prior mirror; the same DATA may carry many.
 *  - `remove(mirrorUID)` → `Hex` — revoke a MIRROR by its own UID (via
 *    `efs.eas.revoke`, MIRROR schema). MIRROR is revocable (the schema PERMITS it and
 *    MirrorResolver REQUIRES `revocable=true` at write time), so a revoke is always valid.
 *  - `list(dataUID, { lens })` → {@link MirrorRecord}[] — the active mirrors the lens
 *    attester(s) placed on the DATA, with their transport + URI (lens-scoped on-chain
 *    via `EFSFileView.getDataMirrors`; revoked excluded). The trusted read path; the
 *    cross-attester `getDataMirrorsAllAttesters` is deliberately NOT exposed here
 *    (it is a debug/discovery surface — a foreign URI must never auto-render, ADR-0056).
 *
 * Writes route through the SAME Submitter seam as `fs.write`/`graph.*`
 * (`submitEdgePlan` → `submitLayeredTier1`); the read reuses the vendored
 * `EFSFileView` ABI (the same `getDataMirrors` the fetch engine reads).
 */

import type { Address, Hex } from 'viem'
import { fileViewAbi } from '../chain/abi/fileView.js'
import type { EfsDeployment } from '../chain/deployments.js'
import { EfsError } from '../errors.js'
import { read } from '../reads/context.js'
import type { ReadPublicClient } from '../reads/context.js'
import { type ResolvePublicClient, resolvePathToAnchor } from '../reads/resolve.js'
import type { WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlan } from './edge-submit.js'
import { buildMirrorPlan } from './edge.js'

/** How many mirror rows to read per `getDataMirrors` window (matches the fetch
 * engine's page size). */
const MIRROR_PAGE = 50n
/** Hard cap on mirror rows scanned in a `list` (matches the router's 500-row ceiling). */
const MAX_MIRRORS = 500n

/** Options for {@link MirrorsNs.add}. */
export interface MirrorAddOptions {
  /** The retrieval URI to publish (`ipfs://…`, `ar://…`, `web3://…`, `https://…`, …).
   * MirrorResolver requires it non-empty and within `MAX_URI_LENGTH` (8192 bytes). */
  uri: string
  /**
   * An explicit `/transports/<scheme>` anchor UID (32-byte hex) to use as the MIRROR
   * `transportDefinition`. When supplied it WINS — the scheme is not consulted. Pass
   * this for any scheme the SDK cannot derive automatically (the deployment has no
   * `transports` entry and there is no `/transports/<scheme>` anchor on-chain). */
  transport?: Hex
}

/** Options for {@link MirrorsNs.list} (lens-scoped, like the other reads). */
export interface MirrorListOptions {
  /** The attester(s) whose active mirrors to read. A single `Address` (the common
   * case) or an ordered list. Defaults to the connected attester. Lens-scoped on-chain:
   * only the named attester's mirrors are returned, so a foreign attester's mirror can
   * never surface under someone else's lens (ADR-0056 / overview load-bearing invariants). */
  lens?: Address | readonly Address[]
}

/** One active MIRROR on a DATA, scoped to the attester who placed it. Mirrors the
 * on-chain `EFSFileView.MirrorItem`. */
export interface MirrorRecord {
  /** The MIRROR attestation's own UID (the handle to revoke it via `remove`). */
  uid: Hex
  /** The `/transports/<scheme>` anchor UID this mirror's URI resolves through. */
  transportDefinition: Hex
  /** The retrieval URI. */
  uri: string
  /** The attester who authored the mirror. */
  attester: Address
}

/** Extract a URI's scheme (`ipfs` from `ipfs://Qm…`, `web3` from `web3://0x…`),
 * lowercased. `undefined` when the string has no `scheme:` prefix. */
function schemeOf(uri: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase()
}

/**
 * Map a URI scheme to the deployment-`transports`-map KEY (the same keys the deploy
 * seeds + `chain/deployments.ts` `EfsTransports` documents). The only normalization is
 * the Arweave alias: a `ar://` URI's scheme is `ar`, but the canonical transport key
 * is `arweave` (matching `mirror/transport.ts`'s `resolveArweave`). Every other
 * recognized scheme (`web3`/`ipfs`/`https`/`data`/`magnet`) is its own key.
 */
function transportKeyForScheme(scheme: string): string {
  return scheme === 'ar' ? 'arweave' : scheme
}

/**
 * Resolve the `/transports/<scheme>` anchor UID for a mirror — the SAME resolution
 * `writes/file.ts` does for the inline web3:// mirror, generalized to any scheme and
 * extended with an on-chain path fallback:
 *
 *  1. An explicit `opts.transport` UID WINS (the unambiguous escape hatch).
 *  2. Else derive from the URI's scheme via the deployment's `transports` map
 *     (`web3`/`ipfs`/`arweave`/`https`/`data`/`magnet` when the deploy seeded them) —
 *     `ar://` is normalized to the `arweave` key.
 *  3. Else fall back to resolving the `/transports/<scheme>` anchor path on-chain via
 *     the indexer (so a deployment that wired the anchor but didn't record the map
 *     still works).
 *
 * Throws a typed {@link EfsError} (`MissingTransport`) when none of these yields a
 * transport anchor — so the SDK fails with a clear, actionable error instead of
 * letting MirrorResolver revert with `InvalidTransport`.
 *
 * @throws {EfsError} `MissingTransport` when the transport anchor cannot be resolved.
 */
export async function resolveMirrorTransport(
  publicClient: ResolvePublicClient,
  deployment: EfsDeployment,
  uri: string,
  transport: Hex | undefined,
): Promise<Hex> {
  // 0. Reject an empty/blank URI up front — BEFORE the explicit-transport early return, so
  // an explicit `transport` can't smuggle an empty URI into the MIRROR plan. MirrorResolver
  // requires a non-empty URI, so encoding `''` would make the caller sign a tx that can
  // only revert; fail closed with the same preflight `InvalidArgument` `fs.write` gives.
  if (uri.trim() === '') {
    throw new EfsError(
      'efs.mirrors.add: the mirror URI is empty. Pass a non-empty URI (e.g. `ipfs://…`, `ar://…`, `web3://…`).',
      { code: 'InvalidArgument' },
    )
  }

  // 1. Explicit UID — unambiguous; never consult the scheme.
  if (transport !== undefined) return transport

  const scheme = schemeOf(uri)
  if (scheme === undefined) {
    throw new EfsError(
      `efs.mirrors.add: the URI '${uri}' has no 'scheme:' prefix, so the transport cannot be derived. Pass an explicit \`transport\` (the /transports/<scheme> anchor UID).`,
      { code: 'MissingTransport' },
    )
  }

  // 2. Derive from the deployment's transports map (the seeded common case).
  const key = transportKeyForScheme(scheme)
  const mapped = deployment.transports?.[key]
  if (mapped !== undefined) return mapped

  // 3. Fall back to resolving the /transports/<segment> anchor on-chain. The path SEGMENT
  // is not always the map key: web3:// bytes live under the anchor named `onchain` (key
  // `web3`). A missing anchor throws `ParentNotFoundError` from the path walk — re-thrown
  // as the typed MissingTransport so the caller gets one stable code.
  const segment = key === 'web3' ? 'onchain' : key
  try {
    return await resolvePathToAnchor(
      publicClient,
      deployment.contracts.indexer,
      `/transports/${segment}`,
    )
  } catch (cause) {
    throw new EfsError(
      `efs.mirrors.add: no transport definition for scheme '${scheme}'. Pass an explicit \`transport\` (the on-chain /transports/${key} anchor UID), or use a deployment whose \`transports\` map records it (the deploy seeds these).`,
      { code: 'MissingTransport', cause },
    )
  }
}

/** The `efs.mirrors.*` write+read surface (present only on a write-capable client). */
export interface MirrorsNs {
  /** Publish one MIRROR (retrieval method) on an existing `dataUID`. ONE signature.
   * Resolves the transport anchor from `opts.transport` (explicit) or the URI scheme;
   * throws `MissingTransport` if neither resolves. Does NOT supersede prior mirrors. */
  add(dataUID: Hex, opts: MirrorAddOptions): Promise<WriteReceipt>
  /** Revoke a MIRROR by its attestation UID (via `efs.eas.revoke`, MIRROR schema). */
  remove(mirrorUID: Hex): Promise<Hex>
  /** The active mirrors on `dataUID`, one per row the lens attester(s) authored
   * (lens-scoped on-chain via `getDataMirrors`; revoked excluded). `lens` defaults to
   * the connected attester. */
  list(dataUID: Hex, opts?: MirrorListOptions): Promise<MirrorRecord[]>
}

/** Dependencies the `mirrors` namespace binds to (built once by the client). */
export interface MirrorsNsDeps {
  readonly getDeployment: () => EfsDeployment
  readonly publicClient: ReadPublicClient
  /** Build the submit context (wallet/public clients + EAS addr + attester). */
  readonly submitContext: () => EdgeSubmitContext
  /** The connected attester (default lens for reads). */
  readonly attester: () => Address | undefined
  /** Revoke a UID under a schema (wired to `efs.eas.revoke`). */
  readonly revoke: (schema: Hex, uid: Hex) => Promise<Hex>
}

/** One row as returned by `getDataMirrors` (lens-scoped). */
type MirrorItemRaw = {
  uid: Hex
  transportDefinition: Hex
  uri: string
  attester: Address
  timestamp: bigint
}

/** Construct the `efs.mirrors.*` namespace bound to a client's deps. */
export function makeMirrorsNs(deps: MirrorsNsDeps): MirrorsNs {
  const lensList = (lens: MirrorListOptions['lens']): readonly Address[] => {
    if (lens === undefined) {
      const me = deps.attester()
      if (me === undefined)
        throw new EfsError('efs.mirrors: no lens supplied and no connected attester.', {
          code: 'LensRequired',
        })
      return [me]
    }
    return typeof lens === 'string' ? [lens] : lens
  }

  return {
    add: async (dataUID, opts) => {
      const dep = deps.getDeployment()
      const transportDefinition = await resolveMirrorTransport(
        deps.publicClient as unknown as ResolvePublicClient,
        dep,
        opts.uri,
        opts.transport,
      )
      const plan = buildMirrorPlan(dep.schemas, dataUID, transportDefinition, opts.uri)
      return submitEdgePlan(plan, deps.submitContext())
    },

    remove: async (mirrorUID) => {
      const dep = deps.getDeployment()
      return deps.revoke(dep.schemas.mirror, mirrorUID)
    },

    list: async (dataUID, opts) => {
      const dep = deps.getDeployment()
      const attesters = lensList(opts?.lens)
      // One lens-scoped scan per attester (independent → multicall coalescing). Each
      // scan pages through `getDataMirrors` until a short window (end of list) or the
      // 500-row cap. The on-chain read is already revoked-excluded + attester-scoped.
      const perAttester = await Promise.all(
        attesters.map(async (attester) => {
          const out: MirrorRecord[] = []
          for (let start = 0n; start < MAX_MIRRORS; start += MIRROR_PAGE) {
            const rows = await read<readonly MirrorItemRaw[]>(deps.publicClient, {
              address: dep.contracts.fileView,
              abi: fileViewAbi,
              functionName: 'getDataMirrors',
              args: [dataUID, attester, start, MIRROR_PAGE],
            })
            for (const m of rows) {
              out.push({
                uid: m.uid,
                transportDefinition: m.transportDefinition,
                uri: m.uri,
                attester: m.attester,
              })
            }
            if (BigInt(rows.length) < MIRROR_PAGE) break // last (short) window
          }
          return out
        }),
      )
      return perAttester.flat()
    },
  }
}
