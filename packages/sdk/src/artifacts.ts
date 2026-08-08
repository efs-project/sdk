/**
 * Durable-artifact serializers (ADR-0019/R3) — the PERSISTENCE format for the
 * refs and receipts the SDK documents as durable. `efs.toJSON` (`json.ts`) is a
 * LOGGING/display helper with a documented-lossy bigint round-trip; these are
 * the typed, versioned pairs durable storage goes through instead:
 *
 *   - restore `bigint`s losslessly (a tagged `{ "$efsbigint": "<decimal>" }`
 *     encoding, schema-independent — a future bigint field round-trips without
 *     a per-field list);
 *   - REJECT incompatible envelopes with typed errors (`UnsupportedArtifact`
 *     for a foreign profile or a newer version — never a silent best-effort
 *     parse that reinterprets a v2 logical ID as a v1 EAS UID;
 *     `MalformedArtifact` for shape failures);
 *   - PRESERVE opaque extensions verbatim (unknown `data` keys + the whole
 *     `ext` bag survive a parse→serialize round-trip, so a foreign tool can
 *     carry profile-specific extras through this SDK unharmed).
 *
 * The envelope: `{ efs: { artifact, profile, v }, data, ext? }`.
 */

import { EfsError } from './errors.js'
import type { DataRef, WriteReceipt } from './types.js'

/** The envelope version THIS module writes and the max it parses. */
const CURRENT_VERSION = 1

/** The persisted-artifact envelope header. */
type ArtifactHeader = {
  artifact: 'DataRef' | 'WriteReceipt'
  profile: 'efs/v1'
  v: number
}

/** A parse hit an envelope this profile/version cannot own — a FOREIGN profile
 * (e.g. a future `efs/v2` artifact: its ids are logical, not EAS UIDs — reading
 * them as v1 would silently mis-dereference) or a NEWER version. Fail closed;
 * never best-effort. */
export class UnsupportedArtifact extends EfsError {
  override name = 'UnsupportedArtifact'
  readonly expectedProfile = 'efs/v1'
  readonly foundProfile?: string
  readonly foundVersion?: number
  constructor(args: { foundProfile?: string; foundVersion?: number }) {
    super(
      args.foundProfile !== undefined && args.foundProfile !== 'efs/v1'
        ? `EFS artifacts: this is an '${args.foundProfile}' artifact — the v1 profile cannot interpret it (its ids are not EAS UIDs). Parse it with the matching profile's SDK.`
        : `EFS artifacts: envelope version ${args.foundVersion} is newer than this SDK understands (max ${CURRENT_VERSION}). Upgrade @efs/sdk.`,
      { code: 'UnsupportedArtifact' },
    )
    if (args.foundProfile !== undefined) this.foundProfile = args.foundProfile
    if (args.foundVersion !== undefined) this.foundVersion = args.foundVersion
  }
}

/** A parse failed structurally — not JSON, no envelope, or a payload missing
 * required fields. Distinct from {@link UnsupportedArtifact}: this input was
 * never a valid artifact of ANY profile. */
export class MalformedArtifact extends EfsError {
  override name = 'MalformedArtifact'
  constructor(detail: string) {
    super(
      `EFS artifacts: not a valid persisted artifact (${detail}). Durable refs/receipts must round-trip through serializeDataRef/serializeWriteReceipt — efs.toJSON output is a logging format, not persistence.`,
      { code: 'MalformedArtifact' },
    )
  }
}

const BIGINT_TAG = '$efsbigint'
/** A single-key object whose key is the tag, or the tag + N escape `$`s —
 * the family the escaping scheme below owns. */
const TAG_FAMILY_RE = /^\$efsbigint\$*$/

/** JSON replacer: tag bigints so the parser can revive them losslessly.
 * INJECTIVE over arbitrary user `data`/`ext`: a user object that happens to
 * look like the tag (single key `$efsbigint`, or an already-escaped form) is
 * escaped by appending `$` to its key; the reviver strips one. Without this,
 * `{ $efsbigint: "5" }` in an ext bag would silently revive as `5n`. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString(10) }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value)
    const k = keys[0]
    if (keys.length === 1 && k !== undefined && TAG_FAMILY_RE.test(k)) {
      return { [`${k}$`]: (value as Record<string, unknown>)[k] }
    }
  }
  return value
}

/** JSON reviver: restore tagged bigints; unescape the escaped tag family. */
function reviver(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value)
    const k = keys[0]
    if (keys.length === 1 && k !== undefined) {
      if (k === BIGINT_TAG && typeof (value as Record<string, unknown>)[k] === 'string') {
        return BigInt((value as Record<string, string>)[k] as string)
      }
      if (k.length > BIGINT_TAG.length && TAG_FAMILY_RE.test(k)) {
        return { [k.slice(0, -1)]: (value as Record<string, unknown>)[k] }
      }
    }
  }
  return value
}

type Envelope = {
  efs: ArtifactHeader
  data: Record<string, unknown>
  ext?: Record<string, unknown>
}

function serialize(artifact: ArtifactHeader['artifact'], data: object, ext?: object): string {
  const envelope: Envelope = {
    efs: { artifact, profile: 'efs/v1', v: CURRENT_VERSION },
    data: data as Record<string, unknown>,
    ...(ext !== undefined ? { ext: ext as Record<string, unknown> } : {}),
  }
  return JSON.stringify(envelope, replacer)
}

function parseEnvelope(json: string, artifact: ArtifactHeader['artifact']): Envelope {
  let raw: unknown
  try {
    raw = JSON.parse(json, reviver)
  } catch {
    throw new MalformedArtifact('not JSON')
  }
  if (typeof raw !== 'object' || raw === null || !('efs' in raw) || !('data' in raw)) {
    throw new MalformedArtifact('missing the { efs, data } envelope')
  }
  const env = raw as Envelope
  const header = env.efs
  if (typeof header !== 'object' || header === null) {
    throw new MalformedArtifact('missing the envelope header')
  }
  if (header.profile !== 'efs/v1') throw new UnsupportedArtifact({ foundProfile: header.profile })
  if (typeof header.v !== 'number' || header.v > CURRENT_VERSION) {
    throw new UnsupportedArtifact({ foundVersion: header.v })
  }
  if (header.artifact !== artifact) {
    throw new MalformedArtifact(
      `expected a ${artifact} artifact, found '${String(header.artifact)}'`,
    )
  }
  if (typeof env.data !== 'object' || env.data === null) {
    throw new MalformedArtifact('missing the data payload')
  }
  return env
}

/** Serialize a {@link DataRef} for DURABLE storage (localStorage, a DB, a URL
 * payload). `ext` carries opaque caller extensions, preserved verbatim. */
export function serializeDataRef(ref: DataRef, ext?: Record<string, unknown>): string {
  // The brand is type-level; strip nothing — unknown future fields ride along.
  const { __brand, ...data } = ref
  return serialize('DataRef', data, ext)
}

/** Parse a persisted {@link DataRef}. Unknown payload keys are PRESERVED on the
 * returned object (opaque-extension rule).
 * @throws {UnsupportedArtifact} foreign profile / newer version.
 * @throws {MalformedArtifact} structural failure. */
export function parseDataRef(json: string): DataRef & { ext?: Record<string, unknown> } {
  const env = parseEnvelope(json, 'DataRef')
  const d = env.data
  if (
    typeof d.uid !== 'string' ||
    typeof d.chainId !== 'number' ||
    typeof d.resolvedBy !== 'string' ||
    d.profile !== 'efs/v1'
  ) {
    throw new MalformedArtifact('DataRef payload missing uid/chainId/resolvedBy/profile')
  }
  // SHAPE-validate the ID fields before branding — a corrupted/foreign blob
  // with `uid: "x"` or a fractional chainId must die HERE as MalformedArtifact
  // (the promised boundary), not later as a misleading chain/ABI error deep in
  // a read path that trusted the brand.
  if (!/^0x[0-9a-fA-F]{64}$/.test(d.uid)) {
    throw new MalformedArtifact(`DataRef uid is not a bytes32 hex string (${d.uid})`)
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.resolvedBy)) {
    throw new MalformedArtifact(`DataRef resolvedBy is not an address (${d.resolvedBy})`)
  }
  if (!Number.isSafeInteger(d.chainId) || d.chainId <= 0) {
    throw new MalformedArtifact(`DataRef chainId is not a positive integer (${String(d.chainId)})`)
  }
  return {
    // Spread FIRST; every load-bearing field (including the brand) is set
    // AFTER it so a crafted payload key can never clobber one.
    ...(d as object),
    __brand: 'DataRef',
    profile: 'efs/v1',
    uid: d.uid as DataRef['uid'],
    chainId: d.chainId,
    resolvedBy: d.resolvedBy as DataRef['resolvedBy'],
    ...(env.ext !== undefined ? { ext: env.ext } : {}),
  }
}

/** Serialize a {@link WriteReceipt} for DURABLE storage — the resume/recovery
 * artifact (`steps` carries the landed UID map). */
export function serializeWriteReceipt(
  receipt: WriteReceipt,
  ext?: Record<string, unknown>,
): string {
  return serialize('WriteReceipt', receipt, ext)
}

/** Parse a persisted {@link WriteReceipt}. Bigint fields (none today; future
 * ones ride the tagged encoding) revive as real bigints.
 * @throws {UnsupportedArtifact} foreign profile / newer version.
 * @throws {MalformedArtifact} structural failure. */
export function parseWriteReceipt(json: string): WriteReceipt & { ext?: Record<string, unknown> } {
  const env = parseEnvelope(json, 'WriteReceipt')
  const d = env.data
  if (!Array.isArray(d.steps) || typeof d.signatureCount !== 'number' || d.profile !== 'efs/v1') {
    throw new MalformedArtifact('WriteReceipt payload missing steps/signatureCount/profile')
  }
  // Same strictness as parseDataRef (this is the RESUME/recovery artifact —
  // a corrupt landed-UID map must fail the boundary, not a later replay):
  // `typeof === 'number'` admits NaN/fractions; step uids must be bytes32.
  if (!Number.isSafeInteger(d.signatureCount) || d.signatureCount < 0) {
    throw new MalformedArtifact(
      `WriteReceipt signatureCount is not a non-negative integer (${String(d.signatureCount)})`,
    )
  }
  for (const step of d.steps as unknown[]) {
    if (
      typeof step !== 'object' ||
      step === null ||
      typeof (step as { id?: unknown }).id !== 'string' ||
      typeof (step as { done?: unknown }).done !== 'boolean'
    ) {
      throw new MalformedArtifact('WriteReceipt step missing id/done')
    }
    const uid = (step as { uid?: unknown }).uid
    if (uid !== undefined && (typeof uid !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(uid))) {
      throw new MalformedArtifact(
        `WriteReceipt step uid is not a bytes32 hex string (${String(uid)})`,
      )
    }
  }
  return {
    ...(d as unknown as WriteReceipt),
    profile: 'efs/v1',
    ...(env.ext !== undefined ? { ext: env.ext } : {}),
  }
}
