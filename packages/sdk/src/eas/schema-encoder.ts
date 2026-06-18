/**
 * A viem-native equivalent of the EAS `SchemaEncoder`.
 *
 * EAS schemas are declared as a Solidity-tuple-like field string, e.g.
 * `"string name, bytes32 schemaUID"`. The on-chain `data` field of an
 * attestation is the ABI encoding of those fields (head/tail encoded exactly
 * like `abi.encode((string,bytes32))`). This module parses the field string
 * into viem `AbiParameter`s and encodes/decodes values against them using
 * `encodeAbiParameters` / `decodeAbiParameters` — no ethers, no eas-sdk
 * (ADR-0002).
 *
 * The empty schema (`""`) — used by EFS's DATA schema — encodes to empty bytes
 * (`0x`) and decodes back to an empty value list.
 */

import {
  type AbiParameter,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
} from 'viem'

/** A single parsed schema field. `name` may be empty (EAS allows unnamed fields). */
export interface SchemaField {
  /** The Solidity type, e.g. `string`, `bytes32`, `uint256`, `bool`, `address`, `uint256[]`. */
  readonly type: string
  /** The field name as declared in the schema string (may be `''`). */
  readonly name: string
}

/**
 * Parse an EAS schema field string into viem `AbiParameter`s.
 *
 * Delegates to viem's ABI-aware `parseAbiParameters`, so tuple and array fields
 * (e.g. `"(uint256 score, string label) result"`, `"uint256[] xs"`) parse
 * correctly — a naive top-level `split(',')` would break on the comma inside a
 * tuple and produce the wrong ABI. The empty/whitespace schema parses to `[]`.
 *
 * @throws if the schema string is malformed (propagated from viem).
 */
export function parseSchemaParameters(schema: string): readonly AbiParameter[] {
  // Normalize ragged whitespace (the EAS form tolerates it; viem's parser is
  // stricter) before delegating: collapse internal runs and tidy around commas.
  const normalized = schema
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
  if (normalized === '') return []
  return parseAbiParameters(normalized)
}

/**
 * Parse an EAS schema into the lightweight `{ type, name }` introspection view
 * (a tuple field surfaces as `type: 'tuple'`; use {@link parseSchemaParameters}
 * for the full encodable shape). Unnamed fields report `name: ''`.
 */
export function parseSchema(schema: string): readonly SchemaField[] {
  return parseSchemaParameters(schema).map((p) => ({ type: p.type, name: p.name ?? '' }))
}

/**
 * Encodes/decodes EAS attestation `data` against a fixed schema field string.
 *
 * Construct once per schema; the parsed params are cached. `encode`/`decode`
 * are the inverse of each other for any well-typed value list.
 */
export class SchemaEncoder {
  /** The original schema field string this encoder was built from. */
  readonly schema: string
  /** The parsed schema fields, in declaration order. */
  readonly fields: readonly SchemaField[]
  private readonly params: readonly AbiParameter[]

  constructor(schema: string) {
    this.schema = schema
    // `params` carries the full ABI shape (tuple components, arrays) for encode/
    // decode; `fields` is the flat introspection view derived from the same parse.
    this.params = parseSchemaParameters(schema)
    this.fields = this.params.map((p) => ({ type: p.type, name: p.name ?? '' }))
  }

  /** Number of fields in the schema (`0` for the empty schema). */
  get length(): number {
    return this.fields.length
  }

  /**
   * ABI-encode `values` (positional, in schema order) into attestation `data`.
   *
   * The empty schema encodes to `0x` regardless of input. For non-empty
   * schemas, `values.length` must equal the field count.
   *
   * @throws if the arity is wrong, or if a value doesn't match its declared type.
   */
  encodeData(values: readonly unknown[]): Hex {
    if (this.params.length === 0) {
      if (values.length !== 0) {
        throw new Error(`Empty schema takes no values, received ${values.length}`)
      }
      return '0x'
    }
    if (values.length !== this.params.length) {
      throw new Error(
        `Schema arity mismatch: expected ${this.params.length} value(s), received ${values.length}`,
      )
    }
    return encodeAbiParameters(this.params, values as never)
  }

  /**
   * Decode attestation `data` back into a positional value list.
   *
   * The empty schema returns `[]` for empty data (`0x` or `''`).
   *
   * @throws if `data` is non-empty for the empty schema, or fails to decode.
   */
  decodeData(data: Hex): readonly unknown[] {
    if (this.params.length === 0) {
      if (data !== '0x' && data !== ('' as Hex)) {
        throw new Error(`Empty schema expects empty data, received ${data}`)
      }
      return []
    }
    return decodeAbiParameters(this.params, data) as readonly unknown[]
  }
}
