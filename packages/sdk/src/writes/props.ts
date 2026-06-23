/**
 * `efs.props` — the standalone **PROPERTY** value primitive (set / get / list).
 *
 * A property is a key→value binding under a DATA (or any anchorable target),
 * authored as the same three-attestation triple the file-write DAG emits for its
 * reserved keys (`contentType`/`contentHash`/`size`), here generalized to an
 * arbitrary key (`writes/edge.ts` `buildPropertyPlan`):
 *
 *   key-ANCHOR(name = key, forSchema = PROPERTY)  +  PROPERTY(value)  +  binding-PIN
 *
 *  - `set(dataUID, key, value)` — author/replace the binding (TWO signatures: the
 *    key-ANCHOR + PROPERTY mint together, then the binding-PIN). Cardinality-1 over
 *    the binding slot, so a later `set` supersedes the value in O1.
 *  - `get(dataUID, key, { lens })` — read the active value the lens attester bound,
 *    reusing the read engine's `readReservedProperty`/`readCustomProperty`.
 *  - `list(dataUID, { lens })` — every property key→value the lens attester bound
 *    under the DATA (enumerates the key-ANCHORs, decodes each name, reads each value).
 *
 * Writes route through the SAME Submitter seam as `fs.write` (`submitEdgePlan`); the
 * reads reuse the existing reserved/custom property readers and the indexer anchor
 * enumerator.
 */

import type { Address, Hex } from 'viem'
import { indexerAbi } from '../chain/abi/indexer.js'
import type { EfsDeployment } from '../chain/deployments.js'
import { easAbi } from '../eas/abi.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'
import { EfsError } from '../errors.js'
import {
  type ReadContext,
  type ReadPublicClient,
  ZERO_UID,
  decodePropertyValue,
  read,
} from '../reads/context.js'
import { readReservedProperty } from '../reads/file.js'
import type { WriteReceipt } from '../types.js'
import { type EdgeSubmitContext, submitEdgePlan } from './edge-submit.js'
import { buildPropertyPlan } from './edge.js'

/** Lens option for the property read verbs. */
export interface PropReadOptions {
  /** The attester whose bound value(s) to read. Defaults to the connected attester. */
  lens?: Address
}

/** One property key→value entry (with the source PROPERTY UID for provenance). */
export interface PropertyEntry {
  key: string
  value: string
  propertyUID: Hex
}

/** The reserved keys the SDK can always enumerate without anchor introspection. */
const RESERVED_KEYS = ['contentType', 'contentHash', 'size', 'name'] as const

const anchorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)

/** The `efs.props` write+read surface (present only on a write-capable client). */
export interface PropsNs {
  /** Author/replace the property `key` = `value` under `dataUID`. Two signatures. */
  set(dataUID: Hex, key: string, value: string, opts?: PropSetOptions): Promise<WriteReceipt>
  /** Read the active value of `key` under `dataUID`, scoped to the lens attester.
   * `undefined` when the key/binding is absent. */
  get(dataUID: Hex, key: string, opts?: PropReadOptions): Promise<string | undefined>
  /** Every property the lens attester bound under `dataUID` (reserved + custom). */
  list(dataUID: Hex, opts?: PropReadOptions): Promise<PropertyEntry[]>
}

/** Options for {@link PropsNs.set} (reserved for future knobs; near-empty today). */
export type PropSetOptions = Record<never, never>

/** Dependencies the `props` namespace binds to (built once by the client). */
export interface PropsNsDeps {
  readonly getDeployment: () => EfsDeployment
  /** Resolve the deployment from the LIVE provider chain for the `list` enumeration READ
   * (a mutable provider can switch chains after construction). Falls back to
   * {@link PropsNsDeps.getDeployment} when omitted (unit tests). `set` keeps `getDeployment`. */
  readonly liveDeployment?: () => EfsDeployment | Promise<EfsDeployment>
  readonly publicClient: ReadPublicClient
  /** Wrap {@link PropsNsDeps.publicClient} with a guard pinned to the LIVE-resolved deployment
   * chain, so `list`'s anchor-enumeration reads fail closed (`WrongChain`) if the provider
   * drifts between `liveDeployment()` and the reads (TOCTOU). Falls back to the unguarded
   * client when omitted. (The per-key value reads route through `readContext`, already guarded.) */
  readonly guardReadClient?: (chainId: number) => ReadPublicClient
  readonly readContext: () => ReadContext | Promise<ReadContext>
  readonly submitContext: () => EdgeSubmitContext
  /** The connected attester (default lens for reads). */
  readonly attester: () => Address | undefined
}

/** Construct the `efs.props` namespace bound to a client's deps. */
export function makePropsNs(deps: PropsNsDeps): PropsNs {
  const lensAttester = (lens: Address | undefined): Address => {
    const a = lens ?? deps.attester()
    if (a === undefined)
      throw new EfsError('efs.props: no lens supplied and no connected attester.', {
        code: 'LensRequired',
      })
    return a
  }

  return {
    set: async (dataUID, key, value) => {
      const ctx = deps.submitContext()
      // Fail closed on a wrong-chain provider BEFORE the planning read below — the
      // key-anchor lookup FEEDS the plan, so a drifted public client could resolve an
      // anchor that only exists on the wrong chain, making the plan reuse a UID absent on
      // the deployment chain (layer-1 mints the PROPERTY, layer-2 PIN reverts referencing a
      // non-existent anchor). Same guard the submit runs per layer, run before the read.
      await ctx.assertChain?.()
      const dep = deps.getDeployment()
      // UPDATE detection (Bug-2 fix). EFS key-ANCHORs are keyed by
      // `(dataUID, key, PROPERTY_SCHEMA_UID)` and are PERMANENT/non-revocable, so
      // re-minting the same slot on a repeat `set` reverts (or binds the new PROPERTY to
      // an anchor the read path does not use, so the visible value never updates).
      // Resolve the existing key-anchor FIRST: when present, the plan reuses it and emits
      // ONLY the new PROPERTY + a binding-PIN bound to it (the cardinality-1 binding
      // supersedes in O1); when absent, the full key-ANCHOR + PROPERTY + binding triple.
      const existingKeyAnchorUID = (await read<Hex>(deps.publicClient, {
        address: dep.contracts.indexer,
        abi: indexerAbi,
        functionName: 'resolveAnchor',
        args: [dataUID, key, dep.schemas.property],
      })) as Hex
      const plan = buildPropertyPlan(
        dep.schemas,
        dataUID,
        key,
        value,
        existingKeyAnchorUID !== ZERO_UID ? existingKeyAnchorUID : undefined,
      )
      return submitEdgePlan(plan, ctx)
    },

    get: async (dataUID, key, opts) => {
      const attester = lensAttester(opts?.lens)
      // Reuse the read engine's reserved/custom property reader (same lookup for any
      // key: resolveAnchor(dataUID, key, PROPERTY) → getActivePinTarget → decode value).
      const prop = await readReservedProperty(
        await deps.readContext(),
        dataUID,
        attester,
        // `readReservedProperty` is typed to the reserved keys but the lookup is
        // key-agnostic (custom keys take the same path), so any key string works.
        key as 'contentType',
      )
      return prop.value
    },

    list: async (dataUID, opts) => {
      const dep = await (deps.liveDeployment ?? deps.getDeployment)()
      // Guard against a chain switch between resolving `dep` and the enumeration reads below
      // (TOCTOU). The per-key value reads use `readContext` (already guarded client-side).
      const pc = deps.guardReadClient?.(dep.chainId) ?? deps.publicClient
      const attester = lensAttester(opts?.lens)

      // Enumerate the key-ANCHORs under the DATA typed as PROPERTY (each property key is
      // a child anchor whose `forSchema = PROPERTY_SCHEMA_UID`) via the CANONICAL,
      // attester-INDEPENDENT enumerator. A property key-anchor is "first-writer-wins"
      // canonical (`set` REUSES an existing anchor — props.ts:106), so a lens attester
      // can bind an active value to a key whose anchor another attester minted first.
      // Filtering enumeration by `[attester]` (getAnchorsBySchemaAndAddressList) would
      // then OMIT that key from `list` even though `get` returns its value — a get/list
      // divergence. So enumerate every property anchor here, then filter to the lens's
      // active binding below (readReservedProperty is lens-scoped; a key the lens has
      // not bound resolves to no value and is dropped). Page by offset — the API
      // promises EVERY property, so a DATA with >256 keys must not be truncated. Anchors
      // are non-revocable (EFSIndexer.sol:376), so a full page always implies more.
      const PAGE = 256n
      const anchorUIDs: Hex[] = []
      let start = 0n
      for (;;) {
        const page = await read<readonly Hex[]>(pc, {
          address: dep.contracts.indexer,
          abi: indexerAbi,
          functionName: 'getAnchorsBySchema',
          args: [dataUID, dep.schemas.property, start, PAGE, false, false],
        })
        anchorUIDs.push(...page)
        if (BigInt(page.length) < PAGE) break
        start += PAGE
      }

      // Decode each anchor's `name` (the property key), then read its active value
      // under the lens. Fan both passes (independent reads → multicall coalescing).
      const names = await Promise.all(
        anchorUIDs.map(async (anchorUID) => {
          const att = await read<{ data: Hex }>(pc, {
            address: dep.contracts.eas,
            abi: easAbi,
            functionName: 'getAttestation',
            args: [anchorUID],
          })
          return decodeAnchorName(att.data)
        }),
      )

      // Pin the per-key value reads to the SAME resolved deployment + guarded client used for
      // the enumeration above — do NOT call `deps.readContext()` here, which would RE-RESOLVE
      // `liveDeployment()` and could read chain-A anchor UIDs against a drifted chain B
      // (returning wrong/empty values instead of failing `WrongChain`). `readReservedProperty`
      // only needs `publicClient` + `deployment` (the attester is passed explicitly).
      const rc = { publicClient: pc, deployment: dep } as ReadContext
      const entries = await Promise.all(
        names.map(async (key) => {
          if (key === undefined) return undefined
          const prop = await readReservedProperty(rc, dataUID, attester, key as 'contentType')
          if (prop.value === undefined || prop.propertyUID === undefined) return undefined
          return { key, value: prop.value, propertyUID: prop.propertyUID }
        }),
      )
      return entries.filter((e): e is PropertyEntry => e !== undefined)
    },
  }
}

/** Decode an ANCHOR attestation's `name` (the `(string name, bytes32 forSchema)`
 * tuple's first field). `undefined` on empty/malformed data. */
function decodeAnchorName(data: Hex): string | undefined {
  if (data === undefined || data === '0x' || data.length <= 2) return undefined
  try {
    // `(string name, bytes32 forSchema)` → positional `[name, forSchema]`.
    const [name] = anchorEncoder.decodeData(data) as [string, Hex]
    return typeof name === 'string' && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

/** Re-export the value decoder so callers/tests can decode a raw PROPERTY blob. */
export { decodePropertyValue, ZERO_UID, RESERVED_KEYS }
