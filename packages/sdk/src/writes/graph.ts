/**
 * Pure, chain-free **file-write graph builder** — the shared core that both the
 * Tier-1 (3-signature, one `multiAttest` per DAG layer) and Tier-2 (one-signature,
 * in-memory UID threading) submit paths consume. It produces a structured,
 * ordered write PLAN and executes nothing (no network, no chain, no wallet).
 *
 * The authoritative spec is `planning/Designs/sdk-minimal-clicks.md`, section
 * "The write steps (frozen-schema attestation graph)": one logical "save this
 * file" = ~13 attestations across 6 frozen schemas in a 4-layer dependency DAG.
 * Both submit tiers build the *same* graph; they differ only in how the real
 * mined EAS UIDs get threaded (across txs vs. in-memory in one tx).
 *
 * ## Why the plan references siblings symbolically
 *
 * A fresh attestation's EAS UID embeds `block.timestamp` (+ a collision bump), so
 * it is unknowable until mined (`EAS.sol` `_getUID`; the verified crux in the
 * spec). A write where attestation B must carry attestation A's UID therefore
 * cannot name A's UID at build time. So the plan refers to fresh siblings
 * **symbolically**: every planned attestation carries a stable local {@link
 * PlannedAttestation.ref} (e.g. `'DATA'`, `'fileAnchor'`, `'prop:contentHash'`),
 * and any field that must point at a *fresh* sibling holds a {@link SymbolicRef}
 * (`{ ref: '<id>' }`) instead of a concrete `Hex`. The submitter resolves each
 * symbol to the real UID once that sibling is mined (Tier 1) or returned in-memory
 * (Tier 2). Pre-existing dependencies (parent anchor, transport anchor, schema
 * UIDs) are concrete `Hex` and pass through unchanged.
 *
 * The two places a fresh sibling can be referenced are an attestation's `refUID`
 * (EAS-native) and, for a PIN, its in-`data` `definition` field. Both accept a
 * {@link RefOrUID}; {@link isSymbolicRef} discriminates them.
 *
 * ## The graph (4 layers; `recipient`/`value`/`expirationTime` = 0 throughout)
 *
 * - **L1** — `DATA` (the content-identity hub; empty schema, `refUID` 0x0,
 *   non-revocable, empty data).
 * - **L2** — `file-ANCHOR` (refUID = pre-existing parent), `MIRROR` (refUID =
 *   DATA), one `key-ANCHOR` per reserved key (refUID = DATA), one `PROPERTY` per
 *   reserved key (refUID 0x0, non-revocable).
 * - **L3** — `placement-PIN` (refUID = DATA, definition = file-ANCHOR), one
 *   `binding-PIN` per reserved key (refUID = PROPERTY, definition = key-ANCHOR).
 *
 * The reserved-key triplet, per key (contentType / contentHash / size): a
 * key-ANCHOR(name=key, refUID=DATA), a PROPERTY(value), and a binding-PIN
 * (definition=key-ANCHOR, refUID=PROPERTY). The L3 PINs are the deepest edges —
 * each references two fresh L2 siblings at once (an anchor as `definition`, a
 * DATA/PROPERTY as `refUID`).
 *
 * The visibility-TAG layer (L3, one per uncovered ancestor folder) is **not**
 * emitted here: it needs an on-chain "which ancestors are already covered" read,
 * which is a resolve-step concern, not part of the pure graph (the spec lists it
 * as `×M` ancestor-dependent). The placement PIN is what makes the file appear;
 * ancestor visibility TAGs are layered by the submitter after the resolve pass.
 *
 * ## `onAttest` constraints honored structurally
 *
 * Each frozen resolver reverts the whole tx on a violation, so the builder bakes
 * the constraints into the emitted requests (cited inline at each site):
 * DATA rejects refUID≠0 / revocable / non-empty data; PROPERTY rejects refUID≠0 /
 * revocable; ANCHOR rejects revocable; PIN/TAG/MIRROR require revocable=true and
 * expirationTime=0.
 *
 * ## Hardlink / dedup short-circuit
 *
 * "Add an existing file at a new path" (or re-upload of identical bytes the caller
 * already resolved to an on-chain DATA UID) reuses that DATA and collapses the
 * whole write to a **single placement PIN** — no DATA/MIRROR/PROPERTY/anchors.
 * Pass `content: { kind: 'hardlink', dataUID }`.
 */

import type { Hex } from 'viem'
import type { EfsSchemaUIDs } from '../chain/deployments.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'

/** The zero address — `recipient` is 0x0 for every EFS write attestation. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
/** The empty UID (`EMPTY_UID`) — a `refUID` of "none". */
export const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/**
 * The DAG layer an attestation belongs to. The submitter serializes layer-by-layer
 * (Tier 1: one `multiAttest` per layer; layer N+1's symbolic refs resolve from
 * layer N's mined UIDs). Within a layer every attestation is independent.
 */
export type WriteLayer = 1 | 2 | 3

/**
 * A placeholder for a *fresh* sibling whose real EAS UID isn't known until mined.
 * `ref` matches some sibling {@link PlannedAttestation.ref} in the same plan. The
 * submitter substitutes the mined UID before sending the dependent attestation.
 */
export interface SymbolicRef {
  readonly ref: string
}

/** A reference that is either a concrete pre-existing UID or a {@link SymbolicRef}. */
export type RefOrUID = Hex | SymbolicRef

/** Discriminate a {@link SymbolicRef} from a concrete `Hex`. */
export function isSymbolicRef(r: RefOrUID): r is SymbolicRef {
  return typeof r === 'object' && r !== null && 'ref' in r
}

/**
 * One attestation in the plan, schema-encoded but with fresh-sibling references
 * left symbolic. Mirrors an EAS `AttestationRequest` plus the local wiring needed
 * to thread symbols: `recipient`/`value`/`expirationTime` are fixed (0x0/0n/0n) so
 * they are not carried per-entry.
 */
export interface PlannedAttestation {
  /** Stable local id (e.g. `'DATA'`, `'fileAnchor'`, `'prop:contentHash'`). Unique
   * within a plan; the target of any sibling {@link SymbolicRef}. */
  readonly ref: string
  /** The DAG layer (1 | 2 | 3) — the submit ordering unit. */
  readonly layer: WriteLayer
  /** Human label for the kind of node, for diagnostics/progress. */
  readonly kind: 'DATA' | 'MIRROR' | 'PROPERTY' | 'ANCHOR' | 'PIN'
  /** The frozen schema UID to attest against. */
  readonly schema: Hex
  /** ABI-encoded attestation `data` (via {@link SchemaEncoder} + {@link EFS_SCHEMA_FIELDS}). */
  readonly data: Hex
  /** Whether the attestation may later be revoked (per the schema's onAttest rule). */
  readonly revocable: boolean
  /** The EAS-native `refUID`: a concrete pre-existing UID, `ZERO_UID`, or symbolic. */
  readonly refUID: RefOrUID
  /** In-`data` symbolic references that the submitter must resolve before encoding
   * is final — currently only a PIN's `definition` field. `[]` when the encoded
   * `data` is already concrete. Each entry names the data field and the symbol it
   * holds; the submitter re-encodes that field once the symbol is mined. */
  readonly dataRefs: readonly PinDataRef[]
}

/**
 * A symbolic reference embedded inside a PIN's encoded `data`. The PIN `definition`
 * (an anchor UID) can be a *fresh* sibling, so its value in {@link
 * PlannedAttestation.data} is a placeholder until the submitter substitutes the
 * mined UID and re-encodes. `field` is the schema field name (`'definition'`).
 */
export interface PinDataRef {
  readonly field: string
  readonly ref: SymbolicRef
}

/** The three reserved metadata keys, each yielding a key-ANCHOR + PROPERTY + binding-PIN triplet. */
export type ReservedKey = 'contentType' | 'contentHash' | 'size'

/** Input to {@link buildFileWriteGraph}. */
export interface FileWriteGraphInput {
  /** The full path the file is being placed at (informational; the parent anchor
   * and file name are passed resolved). */
  readonly path: string
  /** The file content source: fresh bytes (full graph) or a hardlink to an
   * existing on-chain DATA UID (single-PIN short-circuit). */
  readonly content: { kind: 'bytes'; bytes: Uint8Array } | { kind: 'hardlink'; dataUID: Hex }
  /** Retrieval URIs to publish as MIRRORs (one MIRROR per entry). */
  readonly mirrors: readonly string[]
  /** Optional MIME content type; when present, emits the `contentType` reserved triplet. */
  readonly contentType?: string
  /** Bare SHA-256 content digest (ADR-0006) as `0x`-hex, emitted as the
   * `contentHash` reserved triplet's PROPERTY value. */
  readonly contentHash: Hex
  /** File byte length, emitted as the `size` reserved triplet's PROPERTY value. */
  readonly size: bigint
  /** The frozen schema UID set for the target deployment. */
  readonly schemas: EfsSchemaUIDs
  /** Pre-existing `/transports/<scheme>` anchor UID for the MIRROR `transportDefinition`. */
  readonly transportDefinition: Hex
  /** Pre-existing parent folder anchor UID (the file-ANCHOR's `refUID`). */
  readonly parentAnchorUID: Hex
  /** The file's anchor name (canonical encoding; the file-ANCHOR's `name`). */
  readonly fileName: string
}

/** The ordered write plan returned by {@link buildFileWriteGraph}. */
export interface FileWriteGraph {
  /** True iff the hardlink/dedup short-circuit fired (single placement PIN). */
  readonly hardlink: boolean
  /** Every planned attestation, ordered by layer (L1 → L2 → L3). The submitter
   * groups by {@link PlannedAttestation.layer} into `multiAttest` batches. */
  readonly attestations: readonly PlannedAttestation[]
}

/** Stable local ref ids — shared so the submitter can resolve symbols by name. */
export const REF = {
  DATA: 'DATA',
  FILE_ANCHOR: 'fileAnchor',
  PLACEMENT_PIN: 'placementPin',
  mirror: (i: number) => `mirror:${i}`,
  keyAnchor: (k: ReservedKey) => `anchor:${k}`,
  property: (k: ReservedKey) => `prop:${k}`,
  bindingPin: (k: ReservedKey) => `pin:${k}`,
} as const

// Encoders for the frozen field strings (constructed once; SchemaEncoder caches
// its parsed params). DATA is the empty schema ('' -> '0x').
const dataEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.data)
const mirrorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
const propertyEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.property)
const anchorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
const pinEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)

/**
 * The generic (root-typed) anchor schema sentinel used as `forSchema` for the
 * reserved-key anchors. EFS anchors carry a `bytes32 forSchema` content-type
 * field; for the metadata anchors that bind a PROPERTY (`contentType`, etc.) this
 * is the generic `bytes32(0)`, the same sentinel a plain folder uses. (The file
 * placement targets the parent folder via `refUID`/`definition`, not via this
 * field, so the reserved-key anchors don't need a specialized `forSchema`.)
 */
const GENERIC_FOR_SCHEMA = ZERO_UID

/**
 * Build the ordered file-write plan for a single logical "save this file".
 *
 * Pure: it allocates the attestation graph and returns it; it performs no I/O and
 * resolves nothing on-chain. See the module doc for the layer/ref model.
 *
 * @throws never for valid input; the encoders throw on a malformed value (e.g. a
 *   non-hex `contentHash`) — that is a programming error, surfaced eagerly.
 */
export function buildFileWriteGraph(input: FileWriteGraphInput): FileWriteGraph {
  const { schemas } = input

  // ── Hardlink / dedup short-circuit ──────────────────────────────────────────
  // "Add an existing file at a new path" reuses the on-chain DATA and reduces the
  // write to a single placement PIN (spec: "Hardlink / dedup short-circuits").
  // The file-ANCHOR must still exist for the PIN's `definition`; for the hardlink
  // case we still author it (it names the path), but the PIN points its `refUID`
  // at the *pre-existing* DATA UID rather than a fresh one. We keep the file-ANCHOR
  // (L2) + placement-PIN (L3): the "single PIN" framing in the spec is relative to
  // the *content* graph (DATA/MIRROR/PROPERTY/key-anchors) collapsing away — the
  // anchor that names the new path is inherent to placing it anywhere.
  if (input.content.kind === 'hardlink') {
    const fileAnchor = buildFileAnchor(input)
    const placementPin = buildPlacementPin(schemas, input.content.dataUID)
    return { hardlink: true, attestations: [fileAnchor, placementPin] }
  }

  const attestations: PlannedAttestation[] = []

  // ── L1: DATA — the content-identity hub ─────────────────────────────────────
  // EFSIndexer.onAttest DATA branch (EFSIndexer.sol:463-479): refUID must be
  // EMPTY_UID (:472), non-revocable (:473), expirationTime 0 (:474), and empty
  // data (:475). The empty schema encodes to '0x'.
  attestations.push({
    ref: REF.DATA,
    layer: 1,
    kind: 'DATA',
    schema: schemas.data,
    data: dataEncoder.encodeData([]), // '' -> '0x'
    revocable: false, // EFSIndexer.sol:473 — `if (attestation.revocable) return false`
    refUID: ZERO_UID, // EFSIndexer.sol:472 — `if (attestation.refUID != EMPTY_UID) return false`
    dataRefs: [],
  })

  // ── L2: file-ANCHOR — names the path under the parent folder ─────────────────
  attestations.push(buildFileAnchor(input))

  // ── L2: MIRROR ×N — retrieval methods bound to DATA ──────────────────────────
  // MirrorResolver.onAttest (MirrorResolver.sol:142-192): refUID must resolve to a
  // DATA attestation (:154-157), revocable=true (:164 `if (!attestation.revocable)
  // revert NotRevocable`), expirationTime 0 (:165). data = (transportDefinition, uri).
  input.mirrors.forEach((uri, i) => {
    attestations.push({
      ref: REF.mirror(i),
      layer: 2,
      kind: 'MIRROR',
      schema: schemas.mirror,
      data: mirrorEncoder.encodeData([input.transportDefinition, uri]),
      revocable: true, // MirrorResolver.sol:164 — must be revocable
      refUID: { ref: REF.DATA }, // MirrorResolver.sol:154-157 — refUID must be a DATA attestation
      dataRefs: [],
    })
  })

  // ── L2 + L3: reserved-key triplets (key-ANCHOR + PROPERTY + binding-PIN) ──────
  for (const { key, value } of reservedEntries(input)) {
    // L2 key-ANCHOR: name = the reserved key, refUID = DATA (binds the metadata
    // anchor to the file identity). ANCHOR onAttest rejects revocable
    // (EFSIndexer.sol:376 — `if (attestation.revocable) return false`).
    //
    // `forSchema` MUST be the PROPERTY schema UID, NOT the generic sentinel: the
    // kernel indexes the anchor at `_nameToAnchor[DATA][key][forSchema]`
    // (EFSIndexer.sol:432), and the canonical reader (`EFSRouter._getContentType`,
    // mirrored by the SDK's `readReservedProperty`) resolves it via
    // `resolveAnchor(DATA, key, PROPERTY_SCHEMA_UID)`. Writing the key anchor with a
    // generic `forSchema` files it under the wrong third-level key, so the read
    // returns 0 and every reserved PROPERTY (contentType/contentHash/size) is
    // invisible — verification degrades to `no-claim`. (Live-fork bug; the mocks
    // never exercised the real `resolveAnchor` keying.)
    attestations.push({
      ref: REF.keyAnchor(key),
      layer: 2,
      kind: 'ANCHOR',
      schema: schemas.anchor,
      data: anchorEncoder.encodeData([key, schemas.property]),
      revocable: false, // EFSIndexer.sol:376 — anchors are non-revocable
      refUID: { ref: REF.DATA }, // key-ANCHOR is bound to the DATA identity (spec L2 row 4)
      dataRefs: [],
    })

    // L2 PROPERTY: the interned value. PROPERTY onAttest rejects refUID≠0
    // (EFSIndexer.sol:488) and revocable (EFSIndexer.sol:489). data = (value).
    attestations.push({
      ref: REF.property(key),
      layer: 2,
      kind: 'PROPERTY',
      schema: schemas.property,
      data: propertyEncoder.encodeData([value]),
      revocable: false, // EFSIndexer.sol:489 — `if (attestation.revocable) return false`
      refUID: ZERO_UID, // EFSIndexer.sol:488 — `if (attestation.refUID != EMPTY_UID) return false`
      dataRefs: [],
    })

    // L3 binding-PIN: definition = key-ANCHOR (fresh), refUID = PROPERTY (fresh) —
    // the deepest edge, referencing two fresh L2 siblings. PIN onAttest requires
    // revocable=true (EdgeResolver.sol:336) and expirationTime 0 (:337).
    attestations.push(buildBindingPin(schemas, key))
  }

  // ── L3: placement-PIN — definition = file-ANCHOR (fresh), refUID = DATA (fresh) ─
  attestations.push(buildPlacementPin(schemas, { ref: REF.DATA }))

  // Emit grouped by dependency layer (L1 → L2 → L3). The triplets are built
  // key-contiguously above (anchor[2], property[2], pin[3] interleave a layer-3
  // node between layer-2 nodes), so a stable sort by layer is the cheapest way to
  // present a clean per-layer grouping — the unit the submitter batches into one
  // `multiAttest` per layer. Stable, so within a layer the build order is kept.
  const ordered = stableSortByLayer(attestations)
  return { hardlink: false, attestations: ordered }
}

/** Stable sort by layer (ascending). Array.prototype.sort is spec-stable. */
function stableSortByLayer(atts: readonly PlannedAttestation[]): PlannedAttestation[] {
  return [...atts].sort((a, b) => a.layer - b.layer)
}

/** Build the file-ANCHOR (L2): name = fileName, forSchema = generic, refUID = parent. */
function buildFileAnchor(input: FileWriteGraphInput): PlannedAttestation {
  return {
    ref: REF.FILE_ANCHOR,
    layer: 2,
    kind: 'ANCHOR',
    schema: input.schemas.anchor,
    data: anchorEncoder.encodeData([input.fileName, GENERIC_FOR_SCHEMA]),
    revocable: false, // EFSIndexer.sol:376 — anchors are non-revocable
    // Parent folder is pre-existing (resolved before building) — concrete Hex,
    // not symbolic. EFSIndexer resolves the parent from refUID (EFSIndexer.sol:396).
    refUID: input.parentAnchorUID,
    dataRefs: [],
  }
}

/**
 * Build the placement-PIN (L3): definition = file-ANCHOR, refUID = the DATA UID
 * (symbolic for a fresh write, concrete for a hardlink). PIN onAttest requires
 * revocable=true (EdgeResolver.sol:336) and expirationTime 0 (:337); the
 * `definition` is the file-ANCHOR (always a fresh sibling here).
 */
function buildPlacementPin(schemas: EfsSchemaUIDs, dataRef: RefOrUID): PlannedAttestation {
  const definitionRef: SymbolicRef = { ref: REF.FILE_ANCHOR }
  return {
    ref: REF.PLACEMENT_PIN,
    layer: 3,
    kind: 'PIN',
    schema: schemas.pin,
    // `definition` is a fresh anchor UID — encode a placeholder; the submitter
    // re-encodes with the mined file-ANCHOR UID (tracked via `dataRefs`).
    data: pinEncoder.encodeData([ZERO_UID]),
    revocable: true, // EdgeResolver.sol:336 — `if (!attestation.revocable) revert NotRevocable`
    refUID: dataRef, // refUID = DATA (symbolic for fresh, the existing UID for a hardlink)
    dataRefs: [{ field: 'definition', ref: definitionRef }],
  }
}

/**
 * Build a reserved-key binding-PIN (L3): definition = the key-ANCHOR (fresh),
 * refUID = the PROPERTY (fresh). Both are fresh L2 siblings.
 */
function buildBindingPin(schemas: EfsSchemaUIDs, key: ReservedKey): PlannedAttestation {
  const definitionRef: SymbolicRef = { ref: REF.keyAnchor(key) }
  return {
    ref: REF.bindingPin(key),
    layer: 3,
    kind: 'PIN',
    schema: schemas.pin,
    data: pinEncoder.encodeData([ZERO_UID]), // placeholder; definition resolved by submitter
    revocable: true, // EdgeResolver.sol:336 — PIN must be revocable
    refUID: { ref: REF.property(key) }, // refUID = PROPERTY (the binding claim, spec L3 row 7)
    dataRefs: [{ field: 'definition', ref: definitionRef }],
  }
}

/**
 * The reserved-key entries to emit, in canonical order (contentType, contentHash,
 * size), skipping `contentType` when no MIME type is supplied. `contentHash` is
 * already `0x`-hex; `size` is rendered as a decimal string for the PROPERTY value.
 */
function reservedEntries(
  input: FileWriteGraphInput,
): readonly { key: ReservedKey; value: string }[] {
  const out: { key: ReservedKey; value: string }[] = []
  if (input.contentType !== undefined) {
    out.push({ key: 'contentType', value: input.contentType })
  }
  out.push({ key: 'contentHash', value: input.contentHash })
  out.push({ key: 'size', value: input.size.toString() })
  return out
}
