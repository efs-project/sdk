/**
 * Pure, chain-free **edge/value write-graph builders** for the standalone protocol
 * primitives that sit alongside file-write: a single **TAG** edge, the **PROPERTY**
 * triple (key-ANCHOR + free-floating PROPERTY + binding-PIN), and a placement
 * **PIN**. They are the exact same attestation shapes `writes/graph.ts` emits inside
 * the file-write DAG — re-derived here as small, self-contained plans so each verb
 * (`efs.graph.tags`, `efs.props`, `efs.graph.pins`) builds the minimum graph and
 * submits it through the SAME Submitter seam as `fs.write` (`submitLayeredTier1`).
 *
 * Like `graph.ts` these are pure: they allocate a {@link FileWriteGraph}-shaped plan
 * (the seam's unit) and resolve nothing on-chain. The frozen-resolver `onAttest`
 * constraints are baked in identically (cited inline at each site, mirroring
 * `graph.ts`):
 *
 *  - **TAG** (`EdgeResolver.onAttest`, EdgeResolver.sol:336-337): `data =
 *    (definition, weight)`, target rides in `refUID`, must be revocable,
 *    expirationTime 0. A generic TAG generalizes the file graph's folder-visibility
 *    TAG (which is just `TAG(definition = DATA_SCHEMA_UID, refUID = folderAnchor,
 *    weight = 1)`).
 *  - **PROPERTY triple** (`graph.ts` reserved-key triplet, generalized to an
 *    arbitrary key): a non-revocable key-ANCHOR `(name = key, forSchema =
 *    PROPERTY_SCHEMA_UID, refUID = dataUID)` (EFSIndexer.sol:376/432 — the
 *    `forSchema = PROPERTY` keying is load-bearing; a generic sentinel files the
 *    anchor under the wrong slot and the read returns 0), a non-revocable free-
 *    floating PROPERTY `(value)` with `refUID = 0` (EFSIndexer.sol:488-489), and a
 *    revocable binding-PIN `(definition = key-ANCHOR, refUID = PROPERTY)`.
 *  - **PIN** (cardinality 1; EdgeResolver.sol:336-337): `data = (definition =
 *    anchor)`, `refUID = the placed DATA/target`, revocable, expirationTime 0. A new
 *    PIN at the same `(attester, definition, targetSchema)` slot supersedes the prior
 *    one in O(1) (ADR-0041) — that is how `place` replaces the active placement.
 *
 * ## Layering (same model as `graph.ts`)
 *
 * The TAG and PIN plans are single-layer (the target/DATA is a pre-existing concrete
 * UID, so there is no fresh sibling to thread) — they collapse to one `multiAttest`,
 * i.e. ONE signature. The PROPERTY triple is two layers: L1 mints the key-ANCHOR +
 * PROPERTY (independent), L2 mints the binding-PIN whose `definition` (the anchor)
 * and `refUID` (the PROPERTY) are both fresh L1 siblings — so two `multiAttest`s, two
 * signatures. The submitter (`submitLayeredTier1`) threads the symbols exactly as it
 * does for the file graph.
 */

import type { Hex } from 'viem'
import type { EfsSchemaUIDs } from '../chain/deployments.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'
import { type FileWriteGraph, type PlannedAttestation, ZERO_UID } from './graph.js'

// Encoders for the frozen field strings (constructed once; SchemaEncoder caches its
// parsed params). Same field strings `graph.ts` encodes against — re-derived here so
// each verb is self-contained and the module tree-shakes independently.
const tagEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.tag)
const anchorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
const propertyEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.property)
const pinEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)

/** Stable local ref ids for the edge/value plans (the seam resolves symbols by name). */
export const EDGE_REF = {
  TAG: 'tag',
  PIN: 'pin',
  KEY_ANCHOR: 'keyAnchor',
  PROPERTY: 'property',
  BINDING_PIN: 'bindingPin',
} as const

/** The default TAG weight when the caller passes none (ADR-0041 §4: weight is
 * generic per-entry metadata, irrelevant to activity; 1 is the convention). */
export const DEFAULT_TAG_WEIGHT = 1n

/**
 * Build the single-attestation plan for a **TAG** edge:
 * `TAG(definition, refUID = target, weight)`. Single-layer (the target is a
 * pre-existing concrete UID), so it submits as one `multiAttest` — one signature.
 *
 * @param schemas    The frozen schema-UID set (for the TAG schema UID).
 * @param target     The attestation/anchor UID the TAG points at (rides in `refUID`).
 * @param definition The TAG predicate UID (e.g. a `/tags/<name>` definition UID, or
 *   the DATA schema UID for the folder-visibility convention).
 * @param weight     The `int256` weight; defaults to {@link DEFAULT_TAG_WEIGHT} (1).
 */
export function buildTagPlan(
  schemas: EfsSchemaUIDs,
  target: Hex,
  definition: Hex,
  weight: bigint = DEFAULT_TAG_WEIGHT,
): FileWriteGraph {
  const tag: PlannedAttestation = {
    ref: EDGE_REF.TAG,
    layer: 1,
    kind: 'TAG',
    schema: schemas.tag,
    data: tagEncoder.encodeData([definition, weight]),
    revocable: true, // EdgeResolver.sol:336 — TAG must be revocable
    refUID: target, // the tagged target (concrete pre-existing UID)
    dataRefs: [],
  }
  return { hardlink: false, attestations: [tag] }
}

/**
 * Build the **PROPERTY triple** plan binding a `value` under `dataUID` at `key`,
 * generalizing `graph.ts`'s reserved-key triplet to an arbitrary key. Two layers:
 *
 *  - **L1**: a non-revocable key-ANCHOR `(name = key, forSchema = PROPERTY_SCHEMA_UID,
 *    refUID = dataUID)` and a non-revocable free-floating PROPERTY `(value)`
 *    (`refUID = 0`). Independent → one `multiAttest`.
 *  - **L2**: a revocable binding-PIN `(definition = key-ANCHOR, refUID = PROPERTY)`
 *    — both fresh L1 siblings, threaded by the submitter.
 *
 * Two signatures. `set` is idempotent at the slot: the binding-PIN is cardinality-1
 * over `(attester, key-ANCHOR, PROPERTY_SCHEMA_UID)`, so a later `set` of the same
 * key supersedes the prior value in O1 (the key-ANCHOR is reused/re-minted; only the
 * binding moves).
 *
 * @param schemas The frozen schema-UID set (anchor / property / pin UIDs).
 * @param dataUID The DATA (or any anchorable target) the property is bound under.
 * @param key     The property key (the key-ANCHOR `name`).
 * @param value   The property value (the PROPERTY `string value`).
 */
export function buildPropertyPlan(
  schemas: EfsSchemaUIDs,
  dataUID: Hex,
  key: string,
  value: string,
): FileWriteGraph {
  // L1 key-ANCHOR — `forSchema` MUST be the PROPERTY schema UID, not a generic
  // sentinel: the kernel indexes the anchor at `_nameToAnchor[DATA][key][forSchema]`
  // (EFSIndexer.sol:432) and the canonical reader resolves it via
  // `resolveAnchor(DATA, key, PROPERTY_SCHEMA_UID)` (mirrored by the SDK's
  // `readReservedProperty`/`readCustomProperty`). A generic `forSchema` files it
  // under the wrong slot and the read returns 0. (Same crux as graph.ts.)
  const keyAnchor: PlannedAttestation = {
    ref: EDGE_REF.KEY_ANCHOR,
    layer: 1,
    kind: 'ANCHOR',
    schema: schemas.anchor,
    data: anchorEncoder.encodeData([key, schemas.property]),
    revocable: false, // EFSIndexer.sol:376 — anchors are non-revocable
    refUID: dataUID, // the key-ANCHOR is bound to the DATA identity
    dataRefs: [],
  }

  // L1 PROPERTY — the interned value (refUID 0, non-revocable).
  const property: PlannedAttestation = {
    ref: EDGE_REF.PROPERTY,
    layer: 1,
    kind: 'PROPERTY',
    schema: schemas.property,
    data: propertyEncoder.encodeData([value]),
    revocable: false, // EFSIndexer.sol:489 — PROPERTY rejects revocable
    refUID: ZERO_UID, // EFSIndexer.sol:488 — PROPERTY rejects refUID != 0
    dataRefs: [],
  }

  // L2 binding-PIN — definition = key-ANCHOR (fresh L1), refUID = PROPERTY (fresh L1).
  const bindingPin: PlannedAttestation = {
    ref: EDGE_REF.BINDING_PIN,
    layer: 2,
    kind: 'PIN',
    schema: schemas.pin,
    data: pinEncoder.encodeData([ZERO_UID]), // placeholder; submitter re-encodes `definition`
    revocable: true, // EdgeResolver.sol:336 — PIN must be revocable
    refUID: { ref: EDGE_REF.PROPERTY }, // refUID = PROPERTY (the binding claim)
    dataRefs: [{ field: 'definition', ref: { ref: EDGE_REF.KEY_ANCHOR } }],
  }

  return { hardlink: false, attestations: [keyAnchor, property, bindingPin] }
}

/**
 * Build the single-attestation plan for a placement **PIN** (cardinality 1):
 * `PIN(definition = anchor, refUID = dataUID)`. Single-layer (both the anchor and
 * the DATA are pre-existing concrete UIDs), so it submits as one `multiAttest` — one
 * signature. A new PIN at the same `(attester, anchor, DATA_SCHEMA_UID)` slot
 * supersedes the prior placement in O1 (ADR-0041), so `place` replaces whatever was
 * active at that slot.
 *
 * @param schemas The frozen schema-UID set (for the PIN schema UID).
 * @param anchor  The anchor UID the placement is under (the PIN `definition`).
 * @param dataUID The DATA (or target) UID being placed (rides in `refUID`).
 */
export function buildPlacementPinPlan(
  schemas: EfsSchemaUIDs,
  anchor: Hex,
  dataUID: Hex,
): FileWriteGraph {
  const pin: PlannedAttestation = {
    ref: EDGE_REF.PIN,
    layer: 1,
    kind: 'PIN',
    schema: schemas.pin,
    data: pinEncoder.encodeData([anchor]), // definition = the concrete anchor UID
    revocable: true, // EdgeResolver.sol:336 — PIN must be revocable
    refUID: dataUID, // refUID = the placed DATA/target (concrete)
    dataRefs: [], // no fresh siblings — the anchor is concrete, encoded in `data`
  }
  return { hardlink: false, attestations: [pin] }
}
