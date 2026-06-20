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

import type { Address, Hex } from 'viem'
import type { EfsSchemaUIDs } from '../chain/deployments.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'
import { InvalidListConfig } from '../errors.js'
import type { ListTargetType } from '../types.js'
import { type FileWriteGraph, type PlannedAttestation, ZERO_ADDRESS, ZERO_UID } from './graph.js'

// Encoders for the frozen field strings (constructed once; SchemaEncoder caches its
// parsed params). Same field strings `graph.ts` encodes against — re-derived here so
// each verb is self-contained and the module tree-shakes independently.
const tagEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.tag)
const anchorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
const propertyEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.property)
const pinEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)
const mirrorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
const listEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.list)
const listEntryEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.listEntry)
const redirectEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.redirect)

/** Stable local ref ids for the edge/value plans (the seam resolves symbols by name). */
export const EDGE_REF = {
  TAG: 'tag',
  PIN: 'pin',
  KEY_ANCHOR: 'keyAnchor',
  PROPERTY: 'property',
  BINDING_PIN: 'bindingPin',
  /** The minted LIST attestation (its UID is the new `listUID`). */
  LIST: 'list',
  /** The minted LIST_ENTRY attestation (its UID is the entry handle / revoke target). */
  LIST_ENTRY: 'listEntry',
  /** The minted REDIRECT attestation (its UID is the redirect handle / revoke target). */
  REDIRECT: 'redirect',
  /** The minted MIRROR attestation (its UID is the mirror handle / revoke target). */
  MIRROR: 'mirror',
} as const

/**
 * The frozen REDIRECT `kind` discriminators (ADR-0050). **Only the field string
 * `"bytes32 target, uint16 kind"` is frozen — the kind taxonomy is resolver logic +
 * client convention, versioned/upgradeable, NOT part of the schema UID** — so this
 * map is an SDK convention that can grow additively, not an Etched surface.
 *
 *   - `sameAs`       (0) — strong dedup: a duplicate DATA → its canonical DATA. Both
 *     endpoints must be DATA (AliasResolver write-time guard). Auto-followed.
 *   - `supersededBy` (1) — version replacement: an old DATA → its newer DATA. Both
 *     endpoints DATA. Auto-followed.
 *   - `symlink`      (2) — path symlink: a path Anchor → an Anchor or DATA. Source
 *     must be an Anchor (write-time guard). Auto-followed (one hop per ADR-0050).
 *   - `relatedVersion` (3) — weak discovery hint; **never** auto-followed (the SKOS
 *     guard against "sameAs explosion"). `kind >= 3` is resolver-reserved (recorded,
 *     not type-checked on-chain).
 */
export const REDIRECT_KIND = {
  sameAs: 0,
  supersededBy: 1,
  symlink: 2,
  relatedVersion: 3,
} as const

/** The lowest auto-followed `kind` boundary: `kind < REDIRECT_FOLLOW_MAX_KIND` is
 * auto-followed (0,1,2); `kind >= 3` is a discovery hint, never auto-followed
 * (ADR-0050 §"Kind following"). */
export const REDIRECT_FOLLOW_MAX_KIND = 3

/** Map the `'any' | 'addr' | 'schema'` literal union to the on-chain `uint8`
 * `targetType` (0 = ANY, 1 = ADDR, 2 = SCHEMA — IListReader/ListResolver). */
export const TARGET_TYPE_CODE: Record<ListTargetType, number> = {
  any: 0,
  addr: 1,
  schema: 2,
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

/**
 * Build the single-attestation plan for a **REDIRECT** (ADR-0050; AliasResolver):
 * `REDIRECT(refUID = from, data = (to, kind))`. The SOURCE rides in `refUID`; the
 * DESTINATION + `kind` ride in the payload. Single-layer (both endpoints are
 * pre-existing concrete UIDs), so it submits as one `multiAttest` — one signature.
 *
 * Mirrors the AliasResolver `onAttest` shape (AliasResolver.sol:161-198): revocable
 * MUST be `true` (`NotRevocable`), expirationTime MUST be 0 (`HasExpiration`),
 * `target != 0` (`ZeroTarget`), `target != source` (`SelfLoop`). Per-`kind` typing
 * (sameAs/supersededBy → DATA↔DATA; symlink → Anchor source) is enforced ON-CHAIN —
 * the SDK does not pre-read endpoint schemas (it would cost reads on the write hot
 * path and the resolver is authoritative), so a typing violation surfaces as a typed
 * `ContractReverted` (e.g. `SourceNotData`/`TargetNotAnchorOrData`) at submit.
 *
 * Cardinality: REDIRECT is NOT a cardinality-1 schema (unlike PIN). The resolver
 * keeps no `(source, attester)` slot — a source may carry multiple active redirects.
 * `redirects.set` therefore does NOT auto-supersede a prior redirect; replacement is
 * `set` the new one + `remove` the old. Read-time resolution is lens + first-active
 * scoped (see `reads/redirects.ts`).
 *
 * @param schemas The frozen schema-UID set (for the REDIRECT schema UID).
 * @param from    The SOURCE UID (the duplicate DATA, or the path Anchor) — `refUID`.
 * @param to      The DESTINATION UID (the canonical DATA, or target Anchor/DATA).
 * @param kind    The redirect class (see {@link REDIRECT_KIND}); default `sameAs` (0).
 */
export function buildRedirectPlan(
  schemas: EfsSchemaUIDs,
  from: Hex,
  to: Hex,
  kind: number = REDIRECT_KIND.sameAs,
): FileWriteGraph {
  const redirect: PlannedAttestation = {
    ref: EDGE_REF.REDIRECT,
    layer: 1,
    kind: 'REDIRECT',
    schema: schemas.redirect,
    // data = (target, kind) — `kind` is a uint16; SchemaEncoder takes it as a number/bigint.
    data: redirectEncoder.encodeData([to, kind]),
    revocable: true, // AliasResolver.sol:172 — REDIRECT must be revocable
    refUID: from, // AliasResolver — the SOURCE rides in refUID (concrete pre-existing UID)
    dataRefs: [], // no fresh siblings — both endpoints are concrete, encoded in data/refUID
  }
  return { hardlink: false, attestations: [redirect] }
}

/**
 * Build the single-attestation plan for a **MIRROR** (the retrieval-method edge;
 * MirrorResolver.sol): `MIRROR(refUID = dataUID, data = (transportDefinition, uri))`.
 * The SAME attestation shape `writes/graph.ts` emits inline during a file write
 * (`mirrorEncoder.encodeData([transportDefinition, uri])`, `refUID = DATA`,
 * revocable) — re-derived here as a standalone one-attestation plan so a retrieval
 * method can be added to an EXISTING DATA. Single-layer (the DATA + the transport
 * anchor are both pre-existing concrete UIDs), so it submits as one `multiAttest` —
 * one signature.
 *
 * Mirrors the `MirrorResolver.onAttest` shape (MirrorResolver.sol:141-197):
 * `refUID` must resolve to a DATA attestation (:153-156), revocable MUST be `true`
 * (`NotRevocable`, :163), expirationTime MUST be 0 (`HasExpiration`, :164), the URI
 * must be non-empty + within `MAX_URI_LENGTH`, and `transportDefinition` MUST be an
 * ANCHOR descending from the wired `/transports/` root (:181-188). The SDK resolves
 * the transport anchor up front (see `writes/mirrors.ts`) so a bad/missing transport
 * throws a typed `MissingTransport` instead of letting MirrorResolver revert; the
 * descendancy/URI checks remain on-chain (a violation surfaces as `ContractReverted`).
 *
 * Cardinality: MIRROR is NOT cardinality-1 (ADR-0015 — no singleton enforcement).
 * Multiple mirrors per DATA (and per transport) are allowed, so `add` never
 * supersedes a prior mirror; removal is an explicit revoke of the mirror's own UID.
 *
 * @param schemas             The frozen schema-UID set (for the MIRROR schema UID).
 * @param dataUID             The DATA the retrieval method is bound to (`refUID`).
 * @param transportDefinition The `/transports/<scheme>` anchor UID for the URI's scheme.
 * @param uri                 The retrieval URI (`ipfs://…`, `ar://…`, `web3://…`, …).
 */
export function buildMirrorPlan(
  schemas: EfsSchemaUIDs,
  dataUID: Hex,
  transportDefinition: Hex,
  uri: string,
): FileWriteGraph {
  const mirror: PlannedAttestation = {
    ref: EDGE_REF.MIRROR,
    layer: 1,
    kind: 'MIRROR',
    schema: schemas.mirror,
    // data = (transportDefinition, uri) — the EXACT encoder shape graph.ts emits.
    data: mirrorEncoder.encodeData([transportDefinition, uri]),
    revocable: true, // MirrorResolver.sol:163 — MIRROR must be revocable
    refUID: dataUID, // MirrorResolver.sol:153-156 — refUID must be a DATA attestation (concrete)
    dataRefs: [], // no fresh siblings — DATA + transport anchor are both concrete
  }
  return { hardlink: false, attestations: [mirror] }
}

// ── LIST / LIST_ENTRY (curated collections — ADR-0044/0046/0047) ──────────────────

/** The decoded LIST configuration a `lists.create` mints (mirrors {@link ListConfig}
 * minus the read-only echoed/identity fields). Validated by {@link validateListConfig}
 * before {@link buildCreateListPlan} encodes it. */
export interface ListCreateConfig {
  /** Whether the same target may appear more than once. */
  allowsDuplicates: boolean
  /** Whether entries can never be revoked (append-only) vs revocable. */
  appendOnly: boolean
  /** `'any'` (0) opaque keys · `'addr'` (1) addresses · `'schema'` (2) UIDs of one schema. */
  targetType: ListTargetType
  /** For `'schema'`: the required entry schema (nonzero); `ZERO_UID` otherwise. */
  targetSchema?: Hex
  /** Entry cap (`0n` = uncapped; required nonzero when appendOnly && allowsDuplicates). */
  maxEntries?: bigint
}

/**
 * Validate a {@link ListCreateConfig} against the ListResolver `onAttest` invariants
 * BEFORE submit (EFSLib.createList / ListResolver.sol), throwing {@link
 * InvalidListConfig} rather than letting the chain revert the tx:
 *
 *  - `targetType` ≤ 2 (the literal union already constrains this; guarded for the
 *    JS-caller-with-`as` case).
 *  - SCHEMA mode requires a nonzero `targetSchema`; ANY/ADDR require it zero/omitted.
 *  - `appendOnly && allowsDuplicates ⇒ maxEntries != 0` (the resolver requires a cap,
 *    else an append-only dup list could grow unbounded with no dedupe).
 *
 * @returns the normalized `{ targetSchema, maxEntries }` (zeros filled in).
 */
export function validateListConfig(config: ListCreateConfig): {
  targetSchema: Hex
  maxEntries: bigint
} {
  const code = TARGET_TYPE_CODE[config.targetType]
  if (code === undefined || code > 2) {
    throw new InvalidListConfig(
      `targetType must be 'any' (0), 'addr' (1), or 'schema' (2); got '${String(config.targetType)}'.`,
    )
  }
  const targetSchema = config.targetSchema ?? ZERO_UID
  const isSchemaMode = config.targetType === 'schema'
  const hasSchema = targetSchema !== ZERO_UID
  if (isSchemaMode && !hasSchema) {
    throw new InvalidListConfig(
      "a 'schema'-mode list requires a nonzero targetSchema (the single schema every entry must be).",
    )
  }
  if (!isSchemaMode && hasSchema) {
    throw new InvalidListConfig(
      `a '${config.targetType}'-mode list must have a zero targetSchema (only 'schema' mode pins entries to a schema).`,
    )
  }
  const maxEntries = config.maxEntries ?? 0n
  if (config.appendOnly && config.allowsDuplicates && maxEntries === 0n) {
    throw new InvalidListConfig(
      'an append-only list that allows duplicates requires a nonzero maxEntries (the resolver caps it — an uncapped append-only dup list could grow without bound).',
    )
  }
  return { targetSchema, maxEntries }
}

/**
 * Build the single-attestation plan for a **LIST** (mirrors `EFSLib.createList`):
 * `data = abi.encode(allowsDuplicates, appendOnly, targetType, targetSchema,
 * maxEntries)`, `recipient` 0, `refUID` 0, **non-revocable**, expirationTime 0. The
 * caller is the curator (the attester). Single-layer → one `multiAttest` (one popup).
 * The minted attestation's UID is the new `listUID`.
 *
 * Validates the resolver invariants up front ({@link validateListConfig}) so a bad
 * config throws {@link InvalidListConfig} rather than reverting on-chain.
 */
export function buildCreateListPlan(
  schemas: EfsSchemaUIDs,
  config: ListCreateConfig,
): FileWriteGraph {
  const { targetSchema, maxEntries } = validateListConfig(config)
  const list: PlannedAttestation = {
    ref: EDGE_REF.LIST,
    layer: 1,
    kind: 'LIST',
    schema: schemas.list,
    data: listEncoder.encodeData([
      config.allowsDuplicates,
      config.appendOnly,
      TARGET_TYPE_CODE[config.targetType],
      targetSchema,
      maxEntries,
    ]),
    revocable: false, // ListResolver — LIST must be non-revocable
    refUID: ZERO_UID, // ListResolver — LIST must be free-floating
    dataRefs: [],
  }
  return { hardlink: false, attestations: [list] }
}

/**
 * Build the single-attestation plan for a **LIST_ENTRY**, routed by the list's
 * `targetType` (mirrors `EFSLib.addEntry` / `addAddressEntry`):
 *
 *  - **ANY / SCHEMA** → `data = abi.encode(listUID, target)` with a nonzero `target`
 *    member key (ANY: opaque key; SCHEMA: the target attestation UID), `recipient` 0,
 *    `refUID` 0, revocable.
 *  - **ADDR** → the member address rides in `recipient`; `data = abi.encode(listUID,
 *    bytes32(0))` (payload target MUST be zero — ListEntryResolver `BadAddrMode`).
 *    `address(0)` is an explicitly-valid ADDR member.
 *
 * Single-layer → one `multiAttest` (one popup). Both modes: `refUID` MUST be 0 (the
 * LIST is referenced via the payload `listUID`, not `refUID` — `UsesRefUID`).
 *
 * @param target For ANY/SCHEMA: a nonzero `bytes32` member key/UID. For ADDR: the
 *   member `Address` (incl. `address(0)`). Validate shape vs mode before calling, or
 *   use the `lists.add` verb which validates {@link validateAddTarget}.
 */
export function buildAddEntryPlan(
  schemas: EfsSchemaUIDs,
  listUID: Hex,
  targetType: ListTargetType,
  target: Address | Hex,
): FileWriteGraph {
  if (targetType === 'addr') {
    const member = target as Address
    const entry: PlannedAttestation = {
      ref: EDGE_REF.LIST_ENTRY,
      layer: 1,
      kind: 'LIST_ENTRY',
      schema: schemas.listEntry,
      // ADDR mode — payload target MUST be zero; the member rides in recipient.
      data: listEntryEncoder.encodeData([listUID, ZERO_UID]),
      revocable: true, // ListEntryResolver — must be revocable
      refUID: ZERO_UID, // refUID MUST be 0 (UsesRefUID)
      recipient: member, // ADDR mode — the member address (address(0) is valid)
      dataRefs: [],
    }
    return { hardlink: false, attestations: [entry] }
  }
  // ANY / SCHEMA — the member key/UID rides in the payload `target`, recipient 0.
  const entry: PlannedAttestation = {
    ref: EDGE_REF.LIST_ENTRY,
    layer: 1,
    kind: 'LIST_ENTRY',
    schema: schemas.listEntry,
    data: listEntryEncoder.encodeData([listUID, target as Hex]),
    revocable: true, // ListEntryResolver — must be revocable
    refUID: ZERO_UID, // refUID MUST be 0 (UsesRefUID)
    recipient: ZERO_ADDRESS, // ANY/SCHEMA require recipient 0
    dataRefs: [],
  }
  return { hardlink: false, attestations: [entry] }
}

/** A 32-byte hex word (`0x` + 64 hex). */
function isBytes32(s: string): s is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(s)
}

/** A 20-byte hex address (`0x` + 40 hex). */
function isAddress(s: string): s is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}

/**
 * Validate an `add` target against the list's mode, throwing {@link InvalidListConfig}
 * before submit (the resolver would revert otherwise):
 *
 *  - **ADDR** → `target` must be an `Address` (20-byte hex). `address(0)` IS allowed
 *    (an explicitly-valid ADDR member — the resolver derives the key from the nonzero
 *    `recipient` slot, and zero is a legal recipient there).
 *  - **ANY / SCHEMA** → `target` must be a nonzero `bytes32` UID/member key (a zero
 *    key is rejected on-chain).
 *
 * Returns the target unchanged (typed) on success.
 */
export function validateAddTarget(
  targetType: ListTargetType,
  target: Address | Hex,
): Address | Hex {
  if (targetType === 'addr') {
    if (!isAddress(target)) {
      throw new InvalidListConfig(
        `an 'addr'-mode list needs a 20-byte address target; got '${target}'. (address(0) is allowed.)`,
      )
    }
    return target
  }
  if (!isBytes32(target)) {
    throw new InvalidListConfig(
      `a '${targetType}'-mode list needs a 32-byte ${targetType === 'schema' ? 'attestation UID' : 'member key'} target; got '${target}'.`,
    )
  }
  if (target === ZERO_UID) {
    throw new InvalidListConfig(
      `a '${targetType}'-mode list needs a NONZERO target ${targetType === 'schema' ? 'UID' : 'key'} (the zero word is rejected on-chain).`,
    )
  }
  return target
}
