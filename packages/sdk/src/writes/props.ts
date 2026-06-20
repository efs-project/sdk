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
  readonly publicClient: ReadPublicClient
  readonly readContext: () => ReadContext
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
      const dep = deps.getDeployment()
      const plan = buildPropertyPlan(dep.schemas, dataUID, key, value)
      return submitEdgePlan(plan, deps.submitContext())
    },

    get: async (dataUID, key, opts) => {
      const attester = lensAttester(opts?.lens)
      // Reuse the read engine's reserved/custom property reader (same lookup for any
      // key: resolveAnchor(dataUID, key, PROPERTY) → getActivePinTarget → decode value).
      const prop = await readReservedProperty(
        deps.readContext(),
        dataUID,
        attester,
        // `readReservedProperty` is typed to the reserved keys but the lookup is
        // key-agnostic (custom keys take the same path), so any key string works.
        key as 'contentType',
      )
      return prop.value
    },

    list: async (dataUID, opts) => {
      const dep = deps.getDeployment()
      const attester = lensAttester(opts?.lens)

      // Enumerate the key-ANCHORs under the DATA typed as PROPERTY (each property key
      // is a child anchor whose `forSchema = PROPERTY_SCHEMA_UID`), scoped to the lens
      // attester, revoked excluded.
      const [anchorUIDs] = await read<readonly [readonly Hex[], bigint]>(deps.publicClient, {
        address: dep.contracts.indexer,
        abi: indexerAbi,
        functionName: 'getAnchorsBySchemaAndAddressList',
        args: [dataUID, dep.schemas.property, [attester], 0n, 256n, false, false],
      })

      // Decode each anchor's `name` (the property key), then read its active value
      // under the lens. Fan both passes (independent reads → multicall coalescing).
      const names = await Promise.all(
        anchorUIDs.map(async (anchorUID) => {
          const att = await read<{ data: Hex }>(deps.publicClient, {
            address: dep.contracts.eas,
            abi: easAbi,
            functionName: 'getAttestation',
            args: [anchorUID],
          })
          return decodeAnchorName(att.data)
        }),
      )

      const entries = await Promise.all(
        names.map(async (key) => {
          if (key === undefined) return undefined
          const prop = await readReservedProperty(
            deps.readContext(),
            dataUID,
            attester,
            key as 'contentType',
          )
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
