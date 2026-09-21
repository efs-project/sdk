/**
 * `efs.decode` — the round-trip bridge back from the raw layer (P1-4). Dropping to
 * `efs.raw` / `efs.eas.getAttestation` hands you a raw EAS `Attestation`; this
 * decodes it into the SDK's typed view when the schema is one of the frozen nine,
 * else a typed "unknown schema" passthrough — so the escape hatch isn't one-way.
 *
 * It matches the attestation's `schema` UID against the deployment's frozen
 * {@link EfsSchemaUIDs} (the authoritative, integrity-checked map), then decodes
 * the `data` blob with the same {@link SchemaEncoder} the SDK uses everywhere,
 * keyed by {@link EFS_SCHEMA_FIELDS}. The result is a discriminated union over
 * `schema` — `data`/`anchor`/`pin`/`tag`/`mirror`/`property`/`list`/`listEntry`/
 * `redirect` carry named, typed fields; `unknown` carries the raw decode-less
 * attestation so nothing is lost.
 *
 * Pure: {@link decodeAttestation} performs no I/O. On the client, `efs.decode`
 * wraps it with a UID overload that does the `getAttestation` read first.
 */

import type { Hex } from 'viem'
import type { EfsDeployment, EfsSchemaUIDs } from './chain/deployments.js'
import { SchemaEncoder } from './eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS, type EfsSchemaName } from './eas/schemas.js'
import type { Attestation } from './types.js'

/** Compare two `bytes32` UIDs by value (tolerant of casing + leading-zero width). */
function sameUid(a: Hex, b: Hex): boolean {
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    return false
  }
}

/** Resolve an attestation's `schema` UID to the frozen schema name it belongs to,
 * or `undefined` when it isn't one of the nine EFS schemas on this deployment. */
function schemaNameFor(schemas: EfsSchemaUIDs, schemaUID: Hex): EfsSchemaName | undefined {
  for (const [name, uid] of Object.entries(schemas) as [EfsSchemaName, Hex][]) {
    if (sameUid(uid, schemaUID)) return name
  }
  return undefined
}

// ── Decoded field shapes (one per frozen schema; mirror EFS_SCHEMA_FIELDS) ───────

/** ANCHOR — `string name, bytes32 forSchema`. */
export type DecodedAnchor = { name: string; forSchema: Hex }
/** PROPERTY — `string value`. */
export type DecodedProperty = { value: string }
/** DATA — the empty schema (`''`); identity, no fields. */
export type DecodedData = Record<never, never>
/** PIN — `bytes32 definition`. */
export type DecodedPin = { definition: Hex }
/** TAG — `bytes32 definition, int256 weight`. */
export type DecodedTag = { definition: Hex; weight: bigint }
/** MIRROR — `bytes32 transportDefinition, string uri`. */
export type DecodedMirror = { transportDefinition: Hex; uri: string }
/** LIST — `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries`. */
export type DecodedList = {
  allowsDuplicates: boolean
  appendOnly: boolean
  targetType: number
  targetSchema: Hex
  maxEntries: bigint
}
/** LIST_ENTRY — `bytes32 listUID, bytes32 target`. */
export type DecodedListEntry = { listUID: Hex; target: Hex }
/** REDIRECT — `bytes32 target, uint16 kind`. */
export type DecodedRedirect = { target: Hex; kind: number }

/** Map each frozen schema name to its decoded-field shape (the `fields` payload). */
type DecodedFieldsFor = {
  anchor: DecodedAnchor
  property: DecodedProperty
  data: DecodedData
  pin: DecodedPin
  tag: DecodedTag
  mirror: DecodedMirror
  list: DecodedList
  listEntry: DecodedListEntry
  redirect: DecodedRedirect
}

/** A recognized decode result: the schema name as discriminant, the raw
 * attestation, and the named typed `fields`. Generic over the schema name. */
export type DecodedKnown<K extends EfsSchemaName = EfsSchemaName> = {
  [N in K]: {
    /** The matched frozen schema (the discriminant). */
    schema: N
    /** Whether the schema was recognized (always `true` here). */
    known: true
    /** The raw attestation this was decoded from (carried through). */
    attestation: Attestation
    /** The decoded, named fields for this schema. */
    fields: DecodedFieldsFor[N]
  }
}[K]

/** An unrecognized-schema passthrough: the raw attestation, untouched, plus the
 * unrecognized `schemaUID` so a caller can route/inspect it. Nothing is lost — the
 * data is left undecoded because no known field string applies. */
export type DecodedUnknown = {
  schema: 'unknown'
  known: false
  attestation: Attestation
  /** The unrecognized schema UID (for the caller to inspect/route on). */
  schemaUID: Hex
}

/** The discriminated decode result — a recognized EFS schema, or a passthrough. */
export type DecodedAttestation = DecodedKnown | DecodedUnknown

/** Cache one SchemaEncoder per frozen schema (the field strings are constant). */
const encoderCache = new Map<EfsSchemaName, SchemaEncoder>()
function encoderFor(name: EfsSchemaName): SchemaEncoder {
  let enc = encoderCache.get(name)
  if (!enc) {
    enc = new SchemaEncoder(EFS_SCHEMA_FIELDS[name])
    encoderCache.set(name, enc)
  }
  return enc
}

/** Map a positional decoded value list to the named field shape for a schema. */
function shapeFields(
  name: EfsSchemaName,
  values: readonly unknown[],
): DecodedFieldsFor[EfsSchemaName] {
  switch (name) {
    case 'anchor':
      return { name: values[0] as string, forSchema: values[1] as Hex }
    case 'property':
      return { value: values[0] as string }
    case 'data':
      return {}
    case 'pin':
      return { definition: values[0] as Hex }
    case 'tag':
      return { definition: values[0] as Hex, weight: values[1] as bigint }
    case 'mirror':
      return { transportDefinition: values[0] as Hex, uri: values[1] as string }
    case 'list':
      return {
        allowsDuplicates: values[0] as boolean,
        appendOnly: values[1] as boolean,
        targetType: Number(values[2] as number | bigint),
        targetSchema: values[3] as Hex,
        maxEntries: values[4] as bigint,
      }
    case 'listEntry':
      return { listUID: values[0] as Hex, target: values[1] as Hex }
    case 'redirect':
      return { target: values[0] as Hex, kind: Number(values[1] as number | bigint) }
  }
}

/**
 * Decode a raw EAS {@link Attestation} into the SDK's typed view (pure; no I/O).
 *
 * When `attestation.schema` matches one of the deployment's frozen schema UIDs the
 * result is a {@link DecodedKnown} carrying the schema name + named `fields`; any
 * other UID returns a {@link DecodedUnknown} passthrough (the raw attestation,
 * untouched). The `data` is decoded with the SDK's {@link SchemaEncoder} against
 * the matched schema's frozen field string.
 *
 * @param deployment  Source of the frozen {@link EfsSchemaUIDs} to match against —
 *   pass `efs.raw.deployment()`. (Only `.schemas` is read; no chain access.)
 */
export function decodeAttestation(
  attestation: Attestation,
  deployment: Pick<EfsDeployment, 'schemas'>,
): DecodedAttestation {
  const name = schemaNameFor(deployment.schemas, attestation.schema)
  if (name === undefined) {
    return { schema: 'unknown', known: false, attestation, schemaUID: attestation.schema }
  }
  const values = encoderFor(name).decodeData(attestation.data)
  return {
    schema: name,
    known: true,
    attestation,
    fields: shapeFields(name, values),
  } as DecodedKnown
}
