/**
 * Bigint-safe JSON serialization for EFS results (review P3 / DX-polish).
 *
 * EFS result DTOs carry `bigint` fields — `FileInfo.size`, `ListConfig.maxEntries`,
 * the TAG weight reads, `WriteEstimate.gas`, the EAS `Attestation` time fields, etc.
 * `JSON.stringify` THROWS on a `bigint` (`TypeError: Do not know how to serialize a
 * BigInt`), which surprises devs the first time they log a receipt, persist a result,
 * or hand a DTO to a framework that serializes it (TanStack Query's structural-sharing
 * cache, a Next.js Server-Component → Client-Component boundary, `res.json(...)`). This
 * module renders those bigints as DECIMAL STRINGS so the value survives the boundary.
 *
 * ## Round-trip caveat (read this)
 *
 * Serialization is LOSSY of the bigint TYPE: a `bigint` becomes a decimal `string` in
 * the JSON, and `JSON.parse` brings it back as a `string`, NOT a `bigint`. There is no
 * safe automatic reviver — a plain numeric string is indistinguishable from a value the
 * author intended to be a string (a stringified ID, a `Hex` is already a string). So
 * `JSON.parse(efs.toJSON(info))` gives you `info.size` as `"1024"`, and you re-`BigInt(…)`
 * the fields you know are numeric. This matches how viem/wagmi treat bigints at the JSON
 * boundary — there is no canonical round-trip; the producer and consumer agree on which
 * fields are numeric.
 *
 * **NOT PERSISTENCE (ADR-0019/R3).** This is a LOGGING/DISPLAY helper — the
 * bigint round-trip is documented-lossy (decimal strings, no reviver). Durable
 * refs/receipts go through the typed, VERSIONED serializers in `artifacts.ts`
 * (`serializeDataRef`/`parseDataRef`, `serializeWriteReceipt`/
 * `parseWriteReceipt`): those restore bigints, reject foreign-profile/newer
 * envelopes with typed errors, and preserve opaque extensions. `parseWriteReceipt`
 * deliberately REJECTS `toJSON` output (no envelope) — the two formats never mix.
 */

import { EfsError } from './errors.js'

/**
 * A `JSON.stringify` replacer that renders `bigint` values as decimal strings.
 * Pass it as the second argument to `JSON.stringify` to serialize any value that
 * may contain EFS bigints:
 *
 * ```ts
 * import { jsonReplacer } from '@efs/sdk'
 * const json = JSON.stringify(info, jsonReplacer)
 * ```
 *
 * It is a pure, allocation-free function over each visited value: a `bigint` becomes
 * `value.toString()` (base-10, no `n` suffix); everything else passes through
 * unchanged, so it composes with a custom replacer by chaining (call yours, then this
 * on the result) and is safe to reuse across calls (stateless).
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/**
 * Serialize an EFS result (or any value) to a JSON string with `bigint`s rendered as
 * decimal strings — the convenience wrapper over {@link jsonReplacer}. Surfaced as
 * `efs.toJSON` on the client and as a top-level export.
 *
 * ```ts
 * const receipt = await efs.fs.write('/hello.txt', bytes)
 * localStorage.setItem('last-write', efs.toJSON(receipt)) // would throw with bare JSON.stringify
 * ```
 *
 * @param value  The value to serialize (a `WriteReceipt`, `FileInfo`, `ListConfig`,
 *   `EfsList` page, …, or any nested structure containing bigints).
 * @param space  Optional indentation, forwarded to `JSON.stringify` (a number of
 *   spaces or a string) for pretty-printing.
 * @returns The JSON string. See the module note on the round-trip caveat — bigints
 *   come back as strings, not bigints (there is no safe automatic reviver).
 * @throws {EfsError} (`InvalidArgument`) when the root value has NO JSON
 *   representation (`undefined`, a function, or a symbol) — `JSON.stringify`
 *   returns `undefined` for those, which would break this signature's `string`
 *   contract at runtime (and persistence APIs would store the literal text
 *   `"undefined"`). Throwing keeps the promise truthful.
 */
export function toJSON(value: unknown, space?: number | string): string {
  const out = JSON.stringify(value, jsonReplacer, space)
  if (out === undefined) {
    throw new EfsError(
      `efs.toJSON: a ${typeof value} root has no JSON representation — pass a serializable value (object/array/string/number/boolean/null).`,
      { code: 'InvalidArgument' },
    )
  }
  return out
}
