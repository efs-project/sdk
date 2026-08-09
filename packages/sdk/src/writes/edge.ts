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
import { asContentHash } from '../content/hash.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'
import { EfsError, InvalidListConfig } from '../errors.js'
import {
  TRANSPORT,
  UnsupportedUriError,
  cidStructureError,
  resolveTransport,
  summarizeUri,
  uriScheme,
} from '../mirror/transport.js'
import { Web3ReadError, parseWeb3Uri } from '../mirror/web3.js'
import type { CanonicalName } from '../names/segment.js'
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
 *     endpoints must be DATA (AliasResolver write-time guard). Canonicalization
 *     ONLY — NOT followed (specs/09 §2; `redirects.canonical` computes the
 *     lowest-UID-in-SCC representative).
 *   - `supersededBy` (1) — version replacement: an old DATA → its newer DATA. Both
 *     endpoints DATA. A discoverable breadcrumb — NOT auto-followed ("no silent
 *     revision": path = newest, UID = exact; `redirects.history` walks it
 *     deliberately, specs/09 §2).
 *   - `symlink`      (2) — path symlink: a path Anchor → an Anchor or DATA. Source
 *     must be an Anchor (write-time guard). The ONLY auto-followed kind
 *     (specs/09 §2 / ADR-0067, James ratified 2026-06-20).
 *   - `relatedVersion` (3) — weak discovery hint; **never** followed (the SKOS
 *     guard against "sameAs explosion"). `kind >= 3` is resolver-reserved (recorded,
 *     not type-checked on-chain) and INERT to a conformant reader — never
 *     suppression (specs/09 §7/§10 seeding ban).
 */
export const REDIRECT_KIND = {
  sameAs: 0,
  supersededBy: 1,
  symlink: 2,
  relatedVersion: 3,
} as const

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
  return { profile: 'efs/v1', hardlink: false, attestations: [tag] }
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
 * UPDATE (Bug-2 fix): when the caller resolved an EXISTING key-anchor at
 * `(dataUID, key, PROPERTY_SCHEMA_UID)`, pass it as `existingKeyAnchorUID`. EFS
 * key-ANCHORs are PERMANENT/non-revocable, so re-minting the same slot reverts (or
 * mis-binds). With the existing UID supplied the plan emits ONLY the new PROPERTY (L1)
 * + the binding-PIN (L1; its `definition` is the CONCRETE existing key-anchor,
 * `refUID` the fresh PROPERTY threaded from L1) — mirroring Solidity `EFSLib.setPropertyAt`.
 * Omitted ⇒ a NEW key: the full key-ANCHOR + PROPERTY + binding-PIN triple as before.
 *
 * @param schemas The frozen schema-UID set (anchor / property / pin UIDs).
 * @param dataUID The DATA (or any anchorable target) the property is bound under.
 * @param key     The property key (the key-ANCHOR `name`) — the CANONICAL specs/02
 *   encoding; encode a human key with `encodeName()` at the public boundary (the
 *   brand keeps a raw key with a space/reserved byte from reverting the L1 multiAttest).
 * @param value   The property value (the PROPERTY `string value`).
 * @param existingKeyAnchorUID The pre-existing key-anchor UID to REUSE (Bug-2), or
 *   `undefined`/omitted to mint a fresh key-ANCHOR.
 */
export function buildPropertyPlan(
  schemas: EfsSchemaUIDs,
  dataUID: Hex,
  key: CanonicalName,
  value: string,
  existingKeyAnchorUID?: Hex,
): FileWriteGraph {
  // The reserved `contentType` key is the AUTHORITATIVE binding readers trust, and
  // `efs.props.set` reaches it without passing through fs.write's preflight — so the
  // check belongs on the shared builder, where every caller (including direct ones)
  // goes through it (r3742696130). `contentType` is plain ASCII, so its canonical
  // encoding is itself.
  if (key === 'contentType') assertContentType(value, 'EFS property write')
  // The other authoritative reserved key (r3742750216). A malformed hash claim
  // is WORSE than a malformed contentType: readText/readBytes/readJson report
  // `malformed-claim` and THROW even when the mirror bytes are perfectly good,
  // so one bad props.set makes a healthy file unreadable by default. File
  // writes already persist only canonical `ContentHash`; this routes props.set
  // through the same boundary.
  // The third authoritative reserved key (r3742824666). A malformed `size` does
  // NOT degrade gracefully as it first appears: every reader's `parseSize`
  // returns `undefined`, and in `reads/overview.ts` that `undefined` SKIPS the
  // documented pre-fetch `too-large` short-circuit entirely — so instead of
  // returning `{kind:'too-large'}` without touching the network, the overview
  // fetches until it hits the fixed render cap. `fs.info()` simply omits the
  // size. Canonical form only: what `size.toString()` emits, no leading zeros,
  // no sign, no separators.
  if (key === 'size' && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new EfsError(
      `EFS property write: \`size\` ${JSON.stringify(value)} is not a canonical byte count (expected a non-negative decimal integer with no leading zeros, e.g. '4096'). Readers parse this claim strictly and treat anything else as ABSENT, which silently disables fs.overview()'s pre-fetch too-large guard.`,
      { code: 'InvalidArgument' },
    )
  }
  if (key === 'contentHash' && asContentHash(value) === undefined) {
    throw new EfsError(
      `EFS property write: \`contentHash\` ${JSON.stringify(value)} is not a canonical content hash (expected the multibase-multihash form, e.g. \`f1220\` + 64 lowercase hex for sha2-256 — ADR-0016/specs 10 §2.3). This value is the AUTHORITATIVE claim readers verify against, so a malformed one makes every default read throw \`malformed-claim\` even when the bytes are intact. Use \`hashContent(bytes)\`, or \`decodeContentHash(s).canonical\` for an accepted-on-read form.`,
      { code: 'InvalidArgument' },
    )
  }

  // PROPERTY — the interned value (refUID 0, non-revocable). Always minted fresh (new
  // content), whether the key-anchor is reused or not.
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

  // UPDATE (Bug-2): the key-anchor already exists — do NOT re-mint it (it is permanent
  // and re-minting reverts). The binding-PIN's `definition` is the CONCRETE existing
  // key-anchor (encoded directly, no symbolic thread); `refUID` is the fresh PROPERTY.
  // The PROPERTY is L1; the binding-PIN sits at L2 because it refs the fresh PROPERTY.
  if (existingKeyAnchorUID !== undefined) {
    const bindingPin: PlannedAttestation = {
      ref: EDGE_REF.BINDING_PIN,
      layer: 2,
      kind: 'PIN',
      schema: schemas.pin,
      data: pinEncoder.encodeData([existingKeyAnchorUID]), // definition = concrete existing key-anchor
      revocable: true, // EdgeResolver.sol:336 — PIN must be revocable
      refUID: { ref: EDGE_REF.PROPERTY }, // refUID = the fresh PROPERTY (the binding claim)
      dataRefs: [], // definition is concrete — nothing for the submitter to thread
    }
    // REUSE stamps (r3741378777): the boundary gate verifies the reused
    // key-anchor actually names the REQUESTED (dataUID, key, PROPERTY) slot
    // before layer 1 broadcasts — an unrelated anchor would bind the fresh
    // PROPERTY at a definition `props.get(dataUID, key)` never resolves.
    return {
      profile: 'efs/v1',
      hardlink: false,
      anchorSchemaUID: schemas.anchor,
      existingAnchorUID: existingKeyAnchorUID,
      existingAnchorParentUID: dataUID,
      existingAnchorName: key,
      existingAnchorForSchema: schemas.property,
      attestations: [property, bindingPin],
    }
  }

  // NEW key — the full triple. L1 key-ANCHOR — `forSchema` MUST be the PROPERTY schema
  // UID, not a generic sentinel: the kernel indexes the anchor at
  // `_nameToAnchor[DATA][key][forSchema]` (EFSIndexer.sol:432) and the canonical reader
  // resolves it via `resolveAnchor(DATA, key, PROPERTY_SCHEMA_UID)` (mirrored by the
  // SDK's `readReservedProperty`/`readCustomProperty`). A generic `forSchema` files it
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

  return { profile: 'efs/v1', hardlink: false, attestations: [keyAnchor, property, bindingPin] }
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
  // STAMPED as a hardlink placement (r3741335344): this exported builder pairs
  // with the exported submitters, and the layered boundary's gates (authorship,
  // DATA schema, active-mirror readability, ANCHOR definition) key off these
  // stamps — without them the raw pair could place foreign/non-DATA targets at
  // non-ANCHOR definitions. NO slot-binding stamps: the anchor is caller-chosen
  // by design here (there is no requested (parent, name) slot to bind to).
  return {
    profile: 'efs/v1',
    hardlink: true,
    hardlinkDataUID: dataUID,
    dataSchemaUID: schemas.data,
    mirrorSchemaUID: schemas.mirror,
    anchorSchemaUID: schemas.anchor,
    existingAnchorUID: anchor,
    existingAnchorForSchema: schemas.data,
    attestations: [pin],
  }
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
  // SYMLINK plans carry the readability-gate stamps (r3741562776): the
  // exported builder pairs with the exported submitters, and the layered
  // boundary re-runs the direct-DATA mirror proof off these — without them the
  // raw pair could author an unreadable symlink the namespace verb refuses.
  if (kind === REDIRECT_KIND.symlink) {
    return {
      profile: 'efs/v1',
      hardlink: false,
      symlinkTargetUID: to,
      dataSchemaUID: schemas.data,
      mirrorSchemaUID: schemas.mirror,
      attestations: [redirect],
    }
  }
  return { profile: 'efs/v1', hardlink: false, attestations: [redirect] }
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
  // Same URI preflight the other mirror paths run (r3741848624): the exported
  // builder is public surface, and MirrorResolver accepts any nonempty bounded
  // string — a malformed known locator would mint a MIRROR the SDK itself can
  // never resolve (unreadable content when it is the DATA's only mirror).
  validateMirrorUri(uri, 'buildMirrorPlan')
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
  // STAMPED so the layered boundary runs the transport-anchor gate on this
  // standalone plan too (r3741818438): the exported builder + submitEdgePlan
  // pair — and `mirrors.add({ transport })`, which takes the caller's UID
  // verbatim — would otherwise send an arbitrary or stale definition straight
  // to MirrorResolver and pay for a reverted transaction.
  return {
    profile: 'efs/v1',
    hardlink: false,
    anchorSchemaUID: schemas.anchor,
    mirrorTransportUIDs: [transportDefinition],
    attestations: [mirror],
  }
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
  return { profile: 'efs/v1', hardlink: false, attestations: [list] }
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
    return { profile: 'efs/v1', hardlink: false, attestations: [entry] }
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
  return { profile: 'efs/v1', hardlink: false, attestations: [entry] }
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

/** MirrorResolver's `MAX_URI_LENGTH` (MirrorResolver.sol): the UTF-8 BYTE cap on a MIRROR
 * URI. The resolver checks `bytes(uri).length` — UTF-8 bytes, not JS UTF-16 code units. */
export const MAX_MIRROR_URI_BYTES = 8192

/** RFC 9110 `token` — the parameter grammar (names and unquoted values). */
const MEDIA_TOKEN = String.raw`[!#$%&'*+\-.^_\`|~0-9A-Za-z]+`
/**
 * RFC 6838 §4.2 `restricted-name` — the grammar for a type or subtype NAME.
 *
 * Deliberately narrower than {@link MEDIA_TOKEN}, which permits the wildcard
 * character and so accepted MEDIA RANGES — the `text/` + wildcard form a client
 * sends in `Accept`, which is not what a file IS (r3742824661). Stored as
 * authoritative metadata that form even reads as displayable text, because
 * `fs.overview()` keys on the `text/` prefix. A name must start alphanumeric
 * and stay within 127 characters.
 */
const MEDIA_NAME = String.raw`[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}`
/** RFC 9110 `OWS` — SP/HTAB only. Emphatically NOT `\s`, which admits CR and LF
 * (r3742724228). */
const MEDIA_OWS = String.raw`[ \t]*`
/** RFC 9110 `qdtext` — HTAB, SP, and the printable ASCII range excluding `"`
 * (0x22) and `\` (0x5C). Controls are absent by construction. */
const MEDIA_QDTEXT = String.raw`[\t \x21\x23-\x5B\x5D-\x7E]`
/** RFC 9110 `quoted-pair` — a backslash escaping HTAB, SP, or any VCHAR. */
const MEDIA_QUOTED_PAIR = String.raw`\\[\t \x21-\x7E]`
/**
 * `type/subtype` plus optional `; name=value` parameters (value a bare token or
 * a quoted-string).
 *
 * The quoted branch spells out the real grammar rather than `"[^"]*"`, which
 * accepted RAW CONTROLS — a `contentType` of `text/plain; note="a<CR><LF>b"`
 * passed, and that string is persisted as the authoritative PROPERTY and served
 * as the ERC-5219 store's reported MIME, i.e. a CRLF that any gateway echoing
 * the header would emit verbatim (r3742724228).
 */
const MEDIA_TYPE_RE = new RegExp(
  `^${MEDIA_NAME}/${MEDIA_NAME}(?:${MEDIA_OWS};${MEDIA_OWS}${MEDIA_TOKEN}=(?:${MEDIA_TOKEN}|"(?:${MEDIA_QDTEXT}|${MEDIA_QUOTED_PAIR})*"))*$`,
)

/**
 * UTF-8 byte ceiling on `contentType` (r3742696134). RFC 6838 §4.2 caps a type
 * and a subtype name at 127 characters each, so 255 covers any registered
 * `type/subtype` outright and leaves room for parameters — roughly 3× the
 * longest media type in real use.
 *
 * A ceiling is required, not merely tidy: a syntactically VALID but enormous
 * value is ABI-encoded into the `EFSBytesStore` creation transaction, and on the
 * default no-mirror path the SSTORE2 chunk is deployed FIRST. An oversized
 * string makes that second initcode undeployable, stranding the caller with
 * storage they already paid for and a write that cannot complete.
 */
export const MAX_CONTENT_TYPE_BYTES = 255

/**
 * Refuse a `contentType` that is not an IANA media type, or is too large to
 * deploy (r3742578037, r3742696134).
 *
 * specs/future-proofing.md §8 makes the ATTESTED `contentType` authoritative —
 * readers never fall back to the transport header or a file extension — and
 * requires it be validated on write. Lives HERE, beside {@link buildPropertyPlan}
 * and {@link validateMirrorUri}, because `contentType` reaches the chain through
 * more than one door: `fs.write`'s `opts.contentType`, and `efs.props.set`
 * writing the reserved key directly. Validating only the first left the second
 * free to replace the authoritative binding with garbage (r3742696130).
 *
 * @param verb A label for the error message (e.g. `'EFS write'`, `'efs.props.set'`).
 */
export function assertContentType(contentType: string | undefined, verb: string): void {
  if (contentType === undefined) return
  const byteLength = new TextEncoder().encode(contentType).length
  if (byteLength > MAX_CONTENT_TYPE_BYTES) {
    throw new EfsError(
      `${verb}: \`contentType\` is ${byteLength} bytes, over the ${MAX_CONTENT_TYPE_BYTES}-byte limit. A media type this large cannot be deployed into the on-chain store's constructor — and on the default write path the content chunk is deployed FIRST, so the write would strand storage you already paid for. Pass a real media type (e.g. 'text/plain; charset=utf-8').`,
      { code: 'InvalidArgument' },
    )
  }
  if (MEDIA_TYPE_RE.test(contentType)) return
  throw new EfsError(
    `${verb}: \`contentType\` ${JSON.stringify(contentType)} is not an IANA media type (expected \`type/subtype\`, optionally \`; charset=utf-8\`). The attested contentType is AUTHORITATIVE — readers never fall back to the transport header or the file extension — so a malformed value would be minted into the on-chain store and the contentType PROPERTY, and fs.overview() would read the file as binary. Pass a real media type, or omit it to leave the file undeclared.`,
    { code: 'InvalidArgument' },
  )
}

/**
 * Validate a mirror URI BEFORE it is planned/submitted, throwing a typed
 * {@link EfsError} (`InvalidArgument`) so the caller never signs a tx that MirrorResolver
 * can only revert. The resolver rejects an empty URI and one whose UTF-8 byte length
 * exceeds {@link MAX_MIRROR_URI_BYTES}; in `fs.write` such a revert lands at the L2 MIRROR
 * batch AFTER the L1 DATA attestation has mined, orphaning a partial write — so preflight.
 *
 * @param verb A label for the error message (e.g. `'EFS write'`, `'efs.mirrors.add'`).
 */
export function validateMirrorUri(uri: string, verb: string): void {
  if (uri.trim() === '') {
    throw new EfsError(
      `${verb}: a mirror URI is empty. Pass a non-empty URI (e.g. \`ipfs://…\`, \`ar://…\`, \`web3://…\`).`,
      { code: 'InvalidArgument' },
    )
  }
  // Surrounding whitespace is never part of a locator, and it SILENTLY steers
  // the parse below: the scheme regex is anchored, so `" https://…"` matches
  // nothing, falls out of the known-scheme branch, and mints as a "custom"
  // transport — then `resolveTransport` rejects the unchanged string at read
  // time for having no scheme, leaving an only-mirror unreadable (r3742636237).
  // Rejected, not trimmed: the chain stores the string verbatim, so silently
  // rewriting the caller's URI would mint a locator they never wrote.
  // `summarizeUri`, never the raw string: a `data:` mirror carries its payload
  // INLINE, and this runs before the length check, so interpolating the URI
  // would spill up to the full 8 KiB of file content into an error that
  // applications routinely ship to logs and telemetry (r3742660068).
  //
  // Summarize the TRIMMED string: `summarizeUri` detects an inline payload with
  // `/^data:/`, which the very whitespace being reported here would defeat —
  // the URI would fall through to the generic branch and still leak the first
  // 200 characters of the body.
  if (uri !== uri.trim()) {
    throw new EfsError(
      `${verb}: the mirror URI has leading or trailing whitespace ("${summarizeUri(uri.trim())}", shown trimmed). The URI is stored on-chain VERBATIM, so the whitespace would ride along and every read would fail to parse a scheme. Pass the trimmed URI.`,
      { code: 'InvalidArgument' },
    )
  }
  // UTF-8 byte length (MirrorResolver checks `bytes(uri).length`, not the JS string length).
  const byteLength = new TextEncoder().encode(uri).length
  if (byteLength > MAX_MIRROR_URI_BYTES) {
    throw new EfsError(
      `${verb}: the mirror URI is ${byteLength} bytes, over MirrorResolver's ${MAX_MIRROR_URI_BYTES}-byte limit. Use a shorter URI (e.g. a content-addressed \`ipfs://\`/\`ar://\` reference).`,
      { code: 'InvalidArgument' },
    )
  }
  // STRUCTURAL parse for schemes the SDK itself resolves (r3741740332). The
  // chain accepts any nonempty string (ADR-0056 deliberately has no scheme
  // allowlist), so `ipfs://!` mints a perfectly valid MIRROR — and then the
  // SDK's own `resolveTransport` rejects the locator before any fetch, leaving
  // every read AllMirrorsFailed on a confirmed file. Parse the known schemes
  // here; UNKNOWN schemes stay untouched (the custom-transport escape hatch the
  // ADR protects).
  // The SHARED scheme parser (mirror/transport.ts), not a local copy — the copy
  // is exactly how `"https ://…"` got in: it parsed as schemeless here, took the
  // custom-transport path, and minted a mirror `resolveTransport` then refused
  // to parse at read time (r3742660066).
  const scheme = uriScheme(uri)
  // ADR-0056 has no scheme ALLOWLIST, and this is not one: any scheme is fine,
  // but there must BE one. A locator with no syntactically valid `scheme:`
  // prefix is unreadable by every transport, custom ones included, so minting it
  // can only produce a confirmed file that nothing can fetch.
  //
  // Deliberately `MissingTransport`, matching the schemeless rejection in
  // writes/file.ts rather than inventing a second code for one condition. What
  // changes is REACH: an explicit transport anchor used to return before that
  // check, so `"https ://…"` rode the escape hatch straight into a MIRROR.
  if (scheme === undefined) {
    throw new EfsError(
      `${verb}: the mirror URI has no 'scheme:' prefix, so no transport can resolve it ("${summarizeUri(uri)}"). Use a scheme-qualified URI (e.g. 'ipfs://…', 'ar://…', 'web3://…'); a custom scheme is fine (ADR-0056), but an explicit transportDefinition does NOT substitute for one — the reader parses the scheme off the URI itself, so the mirror would confirm and never be readable.`,
      { code: 'MissingTransport' },
    )
  }
  // `ar` is the arweave alias and `http` is resolveTransport's OPT-IN insecure
  // variant (r3741983482) — neither is a TRANSPORT key, but both are schemes the
  // SDK structurally parses, so a malformed one must not slip through as a
  // "custom" scheme.
  const known =
    scheme !== undefined && (scheme === 'ar' || scheme === 'http' || scheme in TRANSPORT)
  if (known) {
    try {
      // Parse http:// with the opt-in ENABLED: the mirror is legitimate for a
      // reader that sets `allowInsecureHttp`, so preflight validates its
      // STRUCTURE without imposing the read-time policy choice on the write.
      resolveTransport(uri, scheme === 'http' ? { allowInsecureHttp: true } : {})
      // `resolveTransport` accepts any alphanumeric CID (reads stay gateway-
      // tolerant), so the WRITE path decodes it properly (r3742105028): an
      // `ipfs://x` mirror mints fine and then no gateway can ever resolve it,
      // leaving the content unreadable when it is the only mirror.
      if (scheme === 'ipfs') {
        let rest = uri.slice('ipfs://'.length)
        if (rest.startsWith('ipfs/')) rest = rest.slice('ipfs/'.length)
        const slash = rest.indexOf('/')
        const cid = slash === -1 ? rest : rest.slice(0, slash)
        const cidError = cidStructureError(cid)
        if (cidError !== undefined) {
          throw new EfsError(
            `${verb}: the mirror URI '${uri}' does not carry a valid IPFS CID (${cidError}). MirrorResolver would accept it, but no gateway could resolve it.`,
            { code: 'InvalidArgument' },
          )
        }
      }
      // `resolveTransport`'s web3 branch defers ADDRESS parsing to the reader
      // (resolution needs a chain client), so it accepts `web3://0x1234` —
      // which then fails every read at `parseWeb3Uri` (r3741771347). Run that
      // strict parser here; it is pure, so preflight can use it directly.
      if (scheme === 'web3') parseWeb3Uri(uri)
    } catch (err) {
      if (err instanceof Web3ReadError) {
        throw new EfsError(
          `${verb}: the mirror URI '${uri}' is not a valid web3: locator (${err.message}). MirrorResolver would accept it, but every read would fail to resolve it — pass \`web3://<20-byte-address>\`.`,
          { code: 'InvalidArgument', cause: err },
        )
      }
      if (err instanceof UnsupportedUriError) {
        throw new EfsError(
          `${verb}: the mirror URI '${uri}' is not a valid ${scheme}: locator (${err.message}). MirrorResolver would accept it, but every read would fail to resolve it — fix the URI, or use a custom scheme if this transport is not one the SDK resolves.`,
          { code: 'InvalidArgument', cause: err },
        )
      }
      throw err
    }
  }
}
