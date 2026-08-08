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
 * The visibility-TAG layer (one per uncovered ancestor folder) is emitted in the
 * LAST layer (after every folder ANCHOR and PIN), but **which** ancestors it covers
 * is a resolve-step decision, not a pure-graph one: the "is this ancestor already
 * tagged by the uploader" check is an on-chain read (`getActiveTagWeight`). So the
 * caller (`writes/file.ts`) does the ancestor walk + short-circuit via
 * `planExistingAncestorVisibilityTags` and passes the result in as
 * {@link FileWriteGraphInput.existingAncestorTagUIDs}; the `createParents` chain
 * ALWAYS needs a TAG (brand-new folders), so those are derived here from
 * `missingParents`. Each TAG is `TAG(definition = DATA_SCHEMA_UID, refUID = folder,
 * weight = 1)` — what makes the folder appear in the uploader's lens listing
 * (overview.md "Upload flow" step 7; specs/02 §4a + §Schema-Hierarchy step 6;
 * ADR-0038, ADR-0041). Root is never tagged (the walk is "up to root exclusive");
 * the file's own leaf is a file, not a folder, so it carries no visibility TAG.
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

import type { Address, Hex } from 'viem'
import type { EfsSchemaUIDs } from '../chain/deployments.js'
import type { ContentHash } from '../content/hash.js'
import { SchemaEncoder } from '../eas/schema-encoder.js'
import { EFS_SCHEMA_FIELDS } from '../eas/schemas.js'
import { EfsError } from '../errors.js'
import { type CanonicalName, isCanonicalName } from '../names/segment.js'

/** The zero address — `recipient` is 0x0 for every EFS write attestation. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
/** The empty UID (`EMPTY_UID`) — a `refUID` of "none". */
export const ZERO_UID = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/**
 * The DAG layer an attestation belongs to. The submitter serializes layer-by-layer
 * (Tier 1: one `multiAttest` per layer; layer N+1's symbolic refs resolve from
 * layer N's mined UIDs). Within a layer every attestation is independent.
 *
 * The base file graph uses layers 1–3 (DATA → L2 → PINs). When missing ancestor
 * folders are created in the same write (`createParents`), the chained folder
 * ANCHORs occupy the EARLIEST layers (one per segment, each referencing the prior)
 * and the DATA/L2/PIN layers are shifted up by the missing-folder count — so a
 * layer is any positive integer, not just `1 | 2 | 3`. The submitter only needs
 * the relative ascending order, never specific values.
 */
export type WriteLayer = number

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
  readonly kind:
    | 'DATA'
    | 'MIRROR'
    | 'PROPERTY'
    | 'ANCHOR'
    | 'PIN'
    | 'TAG'
    | 'LIST'
    | 'LIST_ENTRY'
    | 'REDIRECT'
  /** The frozen schema UID to attest against. */
  readonly schema: Hex
  /** ABI-encoded attestation `data` (via {@link SchemaEncoder} + {@link EFS_SCHEMA_FIELDS}). */
  readonly data: Hex
  /** Whether the attestation may later be revoked (per the schema's onAttest rule). */
  readonly revocable: boolean
  /** The EAS-native `refUID`: a concrete pre-existing UID, `ZERO_UID`, or symbolic. */
  readonly refUID: RefOrUID
  /**
   * The EAS-native `recipient`. `0x0` for every EFS write EXCEPT an ADDR-mode
   * LIST_ENTRY, whose member address rides in `recipient` (the one EFS attestation
   * whose recipient is intentionally nonzero — ListEntryResolver derives the
   * identity key from it; EFSLib.addAddressEntry). Omitted ⇒ `ZERO_ADDRESS`.
   */
  readonly recipient?: Address
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
export interface FileWriteGraphBaseInput {
  /** The full path the file is being placed at (informational; the parent anchor
   * and file name are passed resolved). */
  readonly path: string
  /** The frozen schema UID set for the target deployment. */
  readonly schemas: EfsSchemaUIDs
  /**
   * The anchor UID the file-ANCHOR hangs off of. When no parents are missing this
   * is the file's immediate parent folder. When `missingParents` is non-empty it is
   * the **deepest EXISTING ancestor** (the chain of created folders extends from
   * here); the file-ANCHOR's actual `refUID` is then the last created folder, threaded
   * symbolically — not this UID directly.
   */
  readonly parentAnchorUID: Hex
  /**
   * Ancestor folder segments to create in this same write (`mkdir -p`), ordered
   * SHALLOWEST-first (e.g. `['photos', '2026']` for `/photos/2026/trip.jpg` when
   * neither exists). Empty/omitted ⇒ the parent already exists and the file-ANCHOR
   * refs {@link parentAnchorUID} directly. Each segment becomes one non-revocable
   * ANCHOR whose `refUID` is the previous created folder (the first = the deepest
   * existing anchor = {@link parentAnchorUID}); the file-ANCHOR then refs the last.
   * CANONICAL segments (specs/02) — they are emitted verbatim into the permanent
   * ANCHOR payloads; the `CanonicalName` brand keeps raw human strings out.
   */
  readonly missingParents?: readonly CanonicalName[]
  /**
   * Pre-EXISTING ancestor folder anchor UIDs (concrete) that the uploader has no
   * active visibility TAG on yet, so each needs one emitted in this write. This is
   * the output of the caller's ancestor walk + short-circuit
   * (`planExistingAncestorVisibilityTags` in `reads/resolve.ts`) — the pure graph
   * cannot do the on-chain "already tagged?" read, so the caller resolves it and
   * passes the result. Each becomes a `TAG(definition = DATA_SCHEMA_UID, refUID =
   * UID, weight = 1)`. The freshly-created `missingParents` folders ALWAYS need a
   * TAG and are derived here directly — do NOT include them in this list. Empty/
   * omitted ⇒ every existing ancestor is already covered (steady-state zero cost).
   */
  readonly existingAncestorTagUIDs?: readonly Hex[]
  /** The file's anchor name — the CANONICAL encoding (specs/02), enforced by the
   * brand (the :230-era doc promised canonical; the compiler now holds it). */
  readonly fileName: CanonicalName
  /**
   * An OVERWRITE's reuse of the existing file anchor (Bug-1 fix). EFS file-ANCHORs
   * are keyed by `(parent, fileName, schemas.data)` and are PERMANENT/non-revocable,
   * so re-minting the same slot reverts (`DuplicateFileName`). When this concrete UID
   * is supplied (the caller resolved a pre-existing DATA-typed anchor at this path via
   * `resolveAnchor`), the builder does NOT emit a fresh file-ANCHOR and instead points
   * the placement PIN's `definition` at this CONCRETE UID — the cardinality-1 placement
   * PIN supersedes the prior content in O(1). Omitted/`undefined` ⇒ a first write at
   * this path: the DATA-typed file-ANCHOR is minted fresh (symbolic placement `definition`).
   * Only valid when the parent already exists (no `missingParents`) — a brand-new parent
   * cannot already hold a same-named file anchor.
   */
  readonly existingFileAnchorUID?: Hex
  /**
   * Folder-Overview marker (ADR-0011): when set, emit a `system` TAG on the file's
   * OWN anchor — `TAG(definition = overviewSystemTagDef, refUID = file-ANCHOR,
   * weight = 1)` — in the layer STRICTLY BEFORE the placement PIN, so the file is
   * already `system`-tagged the moment it becomes visible (it never flashes as a
   * visible untagged sibling). `overviewSystemTagDef` is the resolved `/tags/system`
   * definition anchor UID — the SAME def the directory filter excludes on (so a
   * `SAFETY_EXCLUDES` listing hides the README from its own folder). Omitted ⇒ a
   * normal file write (no marker, placement PIN at the base L3). This is the
   * `setOverview` path's ONLY graph difference from `write`.
   */
  readonly overviewSystemTagDef?: Hex
}

/** A FULL write: fresh bytes plus the retrieval metadata the MIRRORs and
 * reserved triplets persist. */
export interface FileWriteBytesInput extends FileWriteGraphBaseInput {
  /** The fresh file bytes (the full DATA/MIRROR/PROPERTY graph is emitted). */
  readonly content: { kind: 'bytes'; bytes: Uint8Array }
  /** Retrieval mirrors to publish (one MIRROR per entry). Each carries its OWN
   * `/transports/<scheme>` anchor UID — a mixed-scheme durability set (e.g.
   * `ipfs://…` + `ar://…`) must NOT share one transport, or later entries are
   * mislabeled on-chain. */
  readonly mirrors: readonly { uri: string; transportDefinition: Hex }[]
  /** Optional MIME content type; when present, emits the `contentType` reserved triplet. */
  readonly contentType?: string
  /** CANONICAL `contentHash` string (specs/10 §2.3, SDK ADR-0016): the
   * multibase-base16 multihash form `f1220<64 lowercase hex>` (sha2-256).
   * Emitted verbatim as the `contentHash` reserved triplet's PROPERTY `string
   * value`. Typed as the `ContentHash` brand so a bare digest or `0x`-prefixed
   * value can never re-enter this NON-REVOCABLE persistence path — the read
   * path would report it `malformed-claim`, and the wrong string would pollute
   * the permanent value-interning index (specs/10 §2.2) forever. */
  readonly contentHash: ContentHash
  /** File byte length, emitted as the `size` reserved triplet's PROPERTY value. */
  readonly size: bigint
}

/** A HARDLINK write: place an EXISTING, SELF-AUTHORED DATA at a path — the
 * single-PIN dedup short-circuit. It carries NO retrieval metadata BY DESIGN
 * (r3741086780): lens-scoped reads resolve MIRRORs/PROPERTYs per placement
 * attester, and the reserved key-ANCHORs are canonical, attester-INDEPENDENT,
 * PERMANENT slots — for any DATA already written with metadata they exist, so
 * a pure builder re-emitting the triplets would REVERT the whole layer
 * (re-minting a permanent anchor). The contract therefore mirrors the Solidity
 * SDK's `ForeignDataUID` gate: the placer must ALREADY have authored the DATA
 * and its metadata (the self-dedup case — that metadata then resolves under
 * the placer's lens automatically). To place FOREIGN content readably,
 * re-publish the bytes as your own write, or place first and attest your own
 * metadata via `efs.mirrors.add` / `efs.props.set` (which RESOLVE the existing
 * canonical key-anchors instead of re-minting them). */
export interface FileWriteHardlinkInput extends FileWriteGraphBaseInput {
  /** The pre-existing, SELF-authored DATA UID to place. */
  readonly content: { kind: 'hardlink'; dataUID: Hex }
}

export type FileWriteGraphInput = FileWriteBytesInput | FileWriteHardlinkInput

/** Nested-discriminant narrowing helper (TS does not narrow the parent union
 * from `input.content.kind` alone). */
function isHardlinkInput(i: FileWriteGraphInput): i is FileWriteHardlinkInput {
  return i.content.kind === 'hardlink'
}

/** The ordered write plan returned by {@link buildFileWriteGraph}. */
export interface FileWriteGraph {
  /** The protocol profile the plan's attestations belong to (ADR-0019): a plan
   * is the artifact a future Tier-2/relay submitter receives across a trust
   * boundary, so it carries the stamp from birth (a serializer is a later
   * slice — this reserves the discriminant). */
  readonly profile: 'efs/v1'
  /** True iff the hardlink/dedup short-circuit fired (single placement PIN). */
  readonly hardlink: boolean
  /** The deployment's DATA schema UID, stamped by the builder so the
   * submitter's hardlink gate can verify the target IS a DATA attestation
   * without a schemas side-channel (r3741189815). A HARDLINK plan without the
   * stamp fails the gate CLOSED (hand-rolled plans must carry it). */
  readonly dataSchemaUID?: Hex
  /** The deployment's MIRROR schema UID — the hardlink gate's READABILITY
   * proof scans the submitter's active mirrors on the target DATA with it
   * (r3741235144). Same fail-closed rule as `dataSchemaUID`. */
  readonly mirrorSchemaUID?: Hex
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
  /** The i-th created ancestor folder ANCHOR (`mkdir -p`), shallowest-first. */
  parentFolder: (i: number) => `parentFolder:${i}`,
  /** Visibility TAG for a freshly-CREATED ancestor folder (refs `parentFolder:i`). */
  createdFolderTag: (i: number) => `visTag:created:${i}`,
  /** Visibility TAG for a pre-EXISTING ancestor folder (refs its concrete UID). */
  existingFolderTag: (i: number) => `visTag:existing:${i}`,
  /** The folder-Overview `system` TAG on the file's OWN anchor (ADR-0011). */
  OVERVIEW_SYSTEM_TAG: 'overviewSystemTag',
} as const

// Encoders for the frozen field strings (constructed once; SchemaEncoder caches
// its parsed params). DATA is the empty schema ('' -> '0x').
const dataEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.data)
const mirrorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.mirror)
const propertyEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.property)
const anchorEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.anchor)
const pinEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.pin)
const tagEncoder = new SchemaEncoder(EFS_SCHEMA_FIELDS.tag)

/** The folder-visibility TAG weight (ADR-0041 §4: weight is irrelevant to activity;
 * weight defaults to 1 by convention). */
const VISIBILITY_TAG_WEIGHT = 1n

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
 * @throws never for valid input; the schema encoders throw on a malformed field
 *   value — that is a programming error, surfaced eagerly. (Reserved-key values
 *   like `contentHash` are plain `string value` PROPERTYs, so any string encodes;
 *   well-formedness of the hash is the caller's contract per ADR-0016.) The one
 *   validated input is the anchor NAMES: the `CanonicalName` brand erases at
 *   runtime, so a cheap dev-guard re-checks them — a smuggled raw segment would
 *   otherwise mint a WRONG PERMANENT anchor slot (or revert mid-write at the
 *   ANCHOR layer after storage deployed).
 */
export function buildFileWriteGraph(input: FileWriteGraphInput): FileWriteGraph {
  const { schemas } = input

  // Dev-guard: the brand promises canonical names, but `as CanonicalName` casts
  // exist — validate before the names enter permanent payloads (specs/02).
  for (const seg of [input.fileName, ...(input.missingParents ?? [])]) {
    if (!isCanonicalName(seg)) {
      throw new EfsError(
        `EFS write plan: anchor name '${seg}' is not in canonical form (specs/02) — encode human segments with encodeName() before building the graph.`,
        { code: 'InvalidAnchorName' },
      )
    }
  }

  // ── `mkdir -p` ancestor folders ─────────────────────────────────────────────
  // When ancestor folders are missing they are created FIRST, as a chain of
  // non-revocable ANCHORs (one per segment), each referencing the previous (the
  // first = the deepest existing anchor). They occupy the earliest layers, one per
  // segment (each refs a fresh sibling in the prior layer, so they can't batch into
  // one layer). The base file graph's layers (1 = DATA, 2 = L2, 3 = PINs) shift up
  // by this count so the chain mines before the file-ANCHOR that depends on it. The
  // file-ANCHOR then refs the *last* created folder (symbolic) instead of the
  // (concrete) parent — see `parentRefFor`.
  const missingParents = input.missingParents ?? []
  const m = missingParents.length
  // Overview marker (ADR-0011): when set, a `system` TAG occupies the layer before
  // the placement PIN, shifting the PIN layers (+1). `ov` is that shift (0 or 1).
  const ov = input.overviewSystemTagDef !== undefined ? 1 : 0
  const folderAttestations = buildParentFolderChain(input)

  // ── Hardlink / dedup short-circuit ──────────────────────────────────────────
  // "Add an existing file at a new path" reuses the on-chain DATA and reduces the
  // write to a single placement PIN (spec: "Hardlink / dedup short-circuits").
  // The file-ANCHOR must still exist for the PIN's `definition`; for the hardlink
  // case we still author it (it names the path), but the PIN points its `refUID`
  // at the *pre-existing* DATA UID rather than a fresh one. We keep the file-ANCHOR
  // + placement-PIN: the "single PIN" framing in the spec is relative to the
  // *content* graph (DATA/MIRROR/PROPERTY/key-anchors) collapsing away — the
  // anchor that names the new path is inherent to placing it anywhere. Any created
  // ancestor folders still precede the anchor, in their own earliest layers.
  if (isHardlinkInput(input)) {
    // JS callers are not bound by the input union — REJECT stray metadata
    // loudly instead of discarding it (r3741086780): silently dropping
    // mirrors/contentHash would yield a placement advertising none of what the
    // caller believed they published (an unreadable, unverifiable file).
    const stray = input as unknown as Partial<FileWriteBytesInput>
    if (
      (stray.mirrors !== undefined && stray.mirrors.length > 0) ||
      stray.contentHash !== undefined ||
      stray.size !== undefined ||
      stray.contentType !== undefined
    ) {
      throw new EfsError(
        'EFS write plan: a HARDLINK plan carries no retrieval metadata — the placer must already have authored the DATA and its mirrors/properties (the self-dedup contract; reserved key-anchors are permanent canonical slots a pure builder cannot safely re-mint). To place foreign content readably, re-publish the bytes as your own write, or place first and attest metadata via efs.mirrors.add / efs.props.set.',
        { code: 'InvalidArgument' },
      )
    }
    // Honor `existingFileAnchorUID` here too (relink/overwrite at an existing path): a
    // file-anchor slot is permanent, so re-minting it reverts. When set, skip the
    // file-ANCHOR mint and place the PIN at the concrete existing anchor (the
    // cardinality-1 placement supersedes); else mint a fresh anchor for a new path.
    const existingFileAnchorUID = input.existingFileAnchorUID
    const fileAnchorAtts =
      existingFileAnchorUID === undefined ? [buildFileAnchor(input, m + 1)] : []
    // Overview marker (ADR-0011) applies to HARDLINK plans too (r3741021024): a
    // hardlinked README must carry the `system` TAG in a layer STRICTLY BEFORE
    // its placement PIN — the early return previously dropped the marker,
    // leaving the Overview visible in safety-filtered directory listings. Same
    // shape as the normal path: TAG targets the file's own anchor (symbolic on
    // a fresh mint, concrete on relink) and `ov` shifts the PIN + TAGs.
    const overviewTag: PlannedAttestation[] =
      input.overviewSystemTagDef !== undefined
        ? [
            {
              ref: REF.OVERVIEW_SYSTEM_TAG,
              layer: m + 2,
              kind: 'TAG',
              schema: schemas.tag,
              data: tagEncoder.encodeData([input.overviewSystemTagDef, VISIBILITY_TAG_WEIGHT]),
              revocable: true, // EdgeResolver.sol — TAG must be revocable
              refUID: existingFileAnchorUID ?? { ref: REF.FILE_ANCHOR },
              dataRefs: [],
            },
          ]
        : []
    const placementPin = buildPlacementPin(
      schemas,
      input.content.dataUID,
      m + 2 + ov,
      existingFileAnchorUID,
    )
    // Visibility TAGs still apply: placing an existing file at a new path must make
    // the uploader's ancestor folders show in their lens. The hardlink graph's PIN
    // lives at m + 2 (+`ov` when the Overview TAG occupies that layer first), so
    // TAGs follow one layer later.
    const visibilityTags = buildVisibilityTags(input, m + 3 + ov)
    return {
      profile: 'efs/v1',
      hardlink: true,
      dataSchemaUID: schemas.data,
      mirrorSchemaUID: schemas.mirror,
      attestations: stableSortByLayer([
        ...folderAttestations,
        ...fileAnchorAtts,
        ...overviewTag,
        placementPin,
        ...visibilityTags,
      ]),
    }
  }

  const attestations: PlannedAttestation[] = [...folderAttestations]

  // ── DATA — the content-identity hub (base layer 1, shifted by `m`) ───────────
  // EFSIndexer.onAttest DATA branch (EFSIndexer.sol:463-479): refUID must be
  // EMPTY_UID (:472), non-revocable (:473), expirationTime 0 (:474), and empty
  // data (:475). The empty schema encodes to '0x'.
  attestations.push({
    ref: REF.DATA,
    layer: m + 1,
    kind: 'DATA',
    schema: schemas.data,
    data: dataEncoder.encodeData([]), // '' -> '0x'
    revocable: false, // EFSIndexer.sol:473 — `if (attestation.revocable) return false`
    refUID: ZERO_UID, // EFSIndexer.sol:472 — `if (attestation.refUID != EMPTY_UID) return false`
    dataRefs: [],
  })

  // ── file-ANCHOR — names the path under the parent folder (base layer 2) ───────
  // OVERWRITE (Bug-1 fix): when the file anchor at `(parent, fileName, DATA)` already
  // exists, it is PERMANENT/non-revocable — re-minting the same slot reverts
  // (`DuplicateFileName`). So skip the file-ANCHOR entirely; the placement PIN and any
  // Overview `system` TAG point at the supplied CONCRETE `existingFileAnchorUID` instead.
  const existingFileAnchorUID = input.existingFileAnchorUID
  if (existingFileAnchorUID === undefined) {
    attestations.push(buildFileAnchor(input, m + 2))
  }
  // The file-ANCHOR reference the Overview TAG + placement PIN target: the freshly
  // minted anchor (symbolic) on a first write, or the concrete reused UID on overwrite.
  const fileAnchorRef: RefOrUID =
    existingFileAnchorUID !== undefined ? existingFileAnchorUID : { ref: REF.FILE_ANCHOR }

  // ── MIRROR ×N — retrieval methods bound to DATA (base layer 2) ───────────────
  // MirrorResolver.onAttest (MirrorResolver.sol:142-192): refUID must resolve to a
  // DATA attestation (:154-157), revocable=true (:164 `if (!attestation.revocable)
  // revert NotRevocable`), expirationTime 0 (:165). data = (transportDefinition, uri).
  // Each mirror carries its OWN transport (per-URI), so a mixed-scheme set is labeled
  // correctly rather than all sharing the first URI's transport.
  input.mirrors.forEach((mirror, i) => {
    attestations.push({
      ref: REF.mirror(i),
      layer: m + 2,
      kind: 'MIRROR',
      schema: schemas.mirror,
      data: mirrorEncoder.encodeData([mirror.transportDefinition, mirror.uri]),
      revocable: true, // MirrorResolver.sol:164 — must be revocable
      refUID: { ref: REF.DATA }, // MirrorResolver.sol:154-157 — refUID must be a DATA attestation
      dataRefs: [],
    })
  })

  // ── reserved-key triplets (key-ANCHOR + PROPERTY @ base L2, binding-PIN @ L3) ──
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
      layer: m + 2,
      kind: 'ANCHOR',
      schema: schemas.anchor,
      data: anchorEncoder.encodeData([key, schemas.property]),
      revocable: false, // EFSIndexer.sol:376 — anchors are non-revocable
      refUID: { ref: REF.DATA }, // key-ANCHOR is bound to the DATA identity (spec L2 row 4)
      dataRefs: [],
    })

    // PROPERTY (base L2): the interned value. PROPERTY onAttest rejects refUID≠0
    // (EFSIndexer.sol:488) and revocable (EFSIndexer.sol:489). data = (value).
    attestations.push({
      ref: REF.property(key),
      layer: m + 2,
      kind: 'PROPERTY',
      schema: schemas.property,
      data: propertyEncoder.encodeData([value]),
      revocable: false, // EFSIndexer.sol:489 — `if (attestation.revocable) return false`
      refUID: ZERO_UID, // EFSIndexer.sol:488 — `if (attestation.refUID != EMPTY_UID) return false`
      dataRefs: [],
    })

    // binding-PIN: definition = key-ANCHOR (fresh), refUID = PROPERTY (fresh) — the
    // deepest edge, referencing two fresh L2 siblings. PIN onAttest requires
    // revocable=true (EdgeResolver.sol:336) and expirationTime 0 (:337). Sits at the
    // PIN layer (base L3, +1 when an Overview `system` TAG is inserted before it).
    attestations.push(buildBindingPin(schemas, key, m + 3 + ov))
  }

  // ── Overview `system` TAG (base L3, BEFORE the placement PIN) ─────────────────
  // ADR-0011: tag the file's OWN anchor `system` in the layer STRICTLY BEFORE the
  // placement PIN, so the README is already hidden the instant it becomes visible
  // (no untagged flash). `refUID` is the freshly-minted file-ANCHOR (symbolic);
  // `definition` = the resolved `/tags/system` def. When this is emitted (`ov === 1`)
  // the placement + binding PINs shift to base L4 (`m + 4`) — guaranteeing the TAG
  // mines in an earlier `multiAttest` than the placement. Absent ⇒ `ov === 0`,
  // nothing emitted, layers unchanged from a normal write.
  if (input.overviewSystemTagDef !== undefined) {
    attestations.push({
      ref: REF.OVERVIEW_SYSTEM_TAG,
      layer: m + 3, // strictly before the placement PIN (now at m + 4)
      kind: 'TAG',
      schema: schemas.tag,
      data: tagEncoder.encodeData([input.overviewSystemTagDef, VISIBILITY_TAG_WEIGHT]),
      revocable: true, // EdgeResolver.sol — TAG must be revocable
      // The file's own anchor: a fresh L2 sibling (symbolic) on a first write, or the
      // concrete reused UID on an overwrite (Bug-1 fix).
      refUID: fileAnchorRef,
      dataRefs: [],
    })
  }

  // ── placement-PIN — definition = file-ANCHOR, refUID = DATA (fresh) ──────────
  // Base L3, shifted to L4 when the Overview `system` TAG occupies L3 (so the TAG
  // mines first — the README is never placed before it is tagged). On an overwrite the
  // `definition` is the concrete reused file-ANCHOR UID (no fresh sibling to thread).
  attestations.push(
    buildPlacementPin(schemas, { ref: REF.DATA }, m + 3 + ov, existingFileAnchorUID),
  )

  // ── visibility TAGs — one per uncovered ancestor folder ──────────────────────
  // Emitted AFTER every folder ANCHOR + PIN so a `createParents`-minted folder is
  // already on-chain when its TAG references it (the TAG's refUID is that fresh
  // folder, symbolic). One layer below the placement PIN. See `buildVisibilityTags`.
  attestations.push(...buildVisibilityTags(input, m + 4 + ov))

  // Emit grouped by dependency layer (created folders → DATA → L2 → PINs). The
  // triplets are built key-contiguously above (anchor/property/pin interleave a
  // deeper node between shallower ones), so a stable sort by layer is the cheapest
  // way to present a clean per-layer grouping — the unit the submitter batches into
  // one `multiAttest` per layer. Stable, so within a layer the build order is kept.
  const ordered = stableSortByLayer(attestations)
  return {
    profile: 'efs/v1',
    hardlink: false,
    dataSchemaUID: schemas.data,
    mirrorSchemaUID: schemas.mirror,
    attestations: ordered,
  }
}

/** Stable sort by layer (ascending). Array.prototype.sort is spec-stable. */
function stableSortByLayer(atts: readonly PlannedAttestation[]): PlannedAttestation[] {
  return [...atts].sort((a, b) => a.layer - b.layer)
}

/**
 * Build the chained ancestor-folder ANCHORs for `mkdir -p` (shallowest-first), one
 * per missing segment, each in its own layer (1 ⇒ shallowest). Each folder is a
 * non-revocable ANCHOR named after its segment with `forSchema = generic` (a plain
 * folder — same primitive a regular directory uses). Its `refUID` is the previous
 * created folder, except the FIRST, which refs the deepest existing anchor
 * (`parentAnchorUID`, concrete). Returns `[]` when no parents are missing.
 */
function buildParentFolderChain(input: FileWriteGraphInput): PlannedAttestation[] {
  const missing = input.missingParents ?? []
  return missing.map((segment, i) => ({
    ref: REF.parentFolder(i),
    // Shallowest folder mines first (layer 1); each deeper folder one layer later.
    layer: i + 1,
    kind: 'ANCHOR' as const,
    schema: input.schemas.anchor,
    data: anchorEncoder.encodeData([segment, GENERIC_FOR_SCHEMA]),
    revocable: false, // EFSIndexer.sol:376 — anchors are non-revocable (folders are permanent)
    // First created folder hangs off the deepest existing anchor (concrete); each
    // subsequent folder off the previous created folder (a fresh sibling, symbolic).
    refUID: i === 0 ? input.parentAnchorUID : { ref: REF.parentFolder(i - 1) },
    dataRefs: [],
  }))
}

/**
 * The reference the file-ANCHOR (and a hardlink placement chain) hangs off: the
 * LAST created folder (symbolic) when parents were created in this write, else the
 * pre-existing parent anchor (concrete `parentAnchorUID`).
 */
function parentRefFor(input: FileWriteGraphInput): RefOrUID {
  const missing = input.missingParents ?? []
  return missing.length > 0 ? { ref: REF.parentFolder(missing.length - 1) } : input.parentAnchorUID
}

/** Build the file-ANCHOR: name = fileName, forSchema = DATA schema, refUID = parent.
 * `layer` is the parent's layer + 1 (base layer 2, shifted by created folders).
 *
 * forSchema MUST be the DATA schema UID, NOT generic. The EFSIndexer keys anchors by
 * `(parent, name, forSchema)`: the router resolves a file's terminal segment via
 * `resolveAnchor(parent, name, DATA_SCHEMA_UID)` (EFSRouter.sol:240-245) and directory
 * listing enumerates only `_childrenBySchema[parent][DATA_SCHEMA_UID]`
 * (EFSFileView.sol:371). A file written generic (`bytes32(0)`) lands in the FOLDER
 * bucket — invisible to file listings and colliding with a same-named folder. Folders
 * stay generic (see {@link buildMissingParentAnchors}). */
function buildFileAnchor(input: FileWriteGraphInput, layer: number): PlannedAttestation {
  return {
    ref: REF.FILE_ANCHOR,
    layer,
    kind: 'ANCHOR',
    schema: input.schemas.anchor,
    data: anchorEncoder.encodeData([input.fileName, input.schemas.data]),
    revocable: false, // EFSIndexer.sol:376 — anchors are non-revocable
    // The parent is the pre-existing folder (concrete Hex) OR — when ancestors are
    // created in this write — the last created folder (symbolic). EFSIndexer
    // resolves the parent from refUID (EFSIndexer.sol:396).
    refUID: parentRefFor(input),
    dataRefs: [],
  }
}

/**
 * Build the placement-PIN: refUID = the DATA UID (symbolic for a fresh write,
 * concrete for a hardlink). The `definition` is the file-ANCHOR — a FRESH sibling
 * for a first write (threaded symbolically via `dataRefs`), or a CONCRETE
 * pre-existing UID on an OVERWRITE that reuses the anchor (Bug-1 fix:
 * `existingFileAnchorUID`), in which case the anchor is encoded directly and there is
 * no `dataRefs` to thread. PIN onAttest requires revocable=true (EdgeResolver.sol:336)
 * and expirationTime 0 (:337). `layer` is the base L3, shifted by any created folders.
 */
function buildPlacementPin(
  schemas: EfsSchemaUIDs,
  dataRef: RefOrUID,
  layer: number,
  existingFileAnchorUID?: Hex,
): PlannedAttestation {
  // OVERWRITE: the file-ANCHOR already exists (not re-minted), so encode the concrete
  // UID into `definition` and carry NO symbolic dataRef.
  if (existingFileAnchorUID !== undefined) {
    return {
      ref: REF.PLACEMENT_PIN,
      layer,
      kind: 'PIN',
      schema: schemas.pin,
      data: pinEncoder.encodeData([existingFileAnchorUID]),
      revocable: true, // EdgeResolver.sol:336 — PIN must be revocable
      refUID: dataRef, // refUID = DATA (symbolic for fresh, concrete for a hardlink)
      dataRefs: [], // definition is concrete — nothing for the submitter to thread
    }
  }
  // FIRST write: `definition` is a FRESH anchor UID — encode a placeholder; the
  // submitter re-encodes with the mined file-ANCHOR UID (tracked via `dataRefs`).
  const definitionRef: SymbolicRef = { ref: REF.FILE_ANCHOR }
  return {
    ref: REF.PLACEMENT_PIN,
    layer,
    kind: 'PIN',
    schema: schemas.pin,
    data: pinEncoder.encodeData([ZERO_UID]),
    revocable: true, // EdgeResolver.sol:336 — `if (!attestation.revocable) revert NotRevocable`
    refUID: dataRef, // refUID = DATA (symbolic for fresh, the existing UID for a hardlink)
    dataRefs: [{ field: 'definition', ref: definitionRef }],
  }
}

/**
 * Build a reserved-key binding-PIN: definition = the key-ANCHOR (fresh), refUID =
 * the PROPERTY (fresh). Both are fresh L2 siblings. `layer` is the base L3, shifted.
 */
function buildBindingPin(
  schemas: EfsSchemaUIDs,
  key: ReservedKey,
  layer: number,
): PlannedAttestation {
  const definitionRef: SymbolicRef = { ref: REF.keyAnchor(key) }
  return {
    ref: REF.bindingPin(key),
    layer,
    kind: 'PIN',
    schema: schemas.pin,
    data: pinEncoder.encodeData([ZERO_UID]), // placeholder; definition resolved by submitter
    revocable: true, // EdgeResolver.sol:336 — PIN must be revocable
    refUID: { ref: REF.property(key) }, // refUID = PROPERTY (the binding claim, spec L3 row 7)
    dataRefs: [{ field: 'definition', ref: definitionRef }],
  }
}

/**
 * Build the folder-visibility TAGs (overview.md "Upload flow" step 7; specs/02 §4a
 * "Folder visibility" + §Schema-Hierarchy step 6; ADR-0038, ADR-0041). One TAG per
 * uncovered ancestor folder so the folder shows in the uploader's lens listing:
 *
 *   `TAG(definition = DATA_SCHEMA_UID, refUID = folderAnchor, weight = 1)`
 *
 * Two sources of uncovered folders, both placed in `layer` (after every folder
 * ANCHOR + PIN, so a freshly-minted folder exists before its TAG references it):
 *
 *  - **Freshly-created** folders (`missingParents`): brand-new, so they ALWAYS need
 *    a TAG. Each TAG's `refUID` is that folder's symbolic ref (`parentFolder:i`),
 *    minted in an earlier layer and resolved by the submitter.
 *  - **Pre-existing** ancestors the caller's walk found untagged
 *    (`existingAncestorTagUIDs`): each TAG's `refUID` is the concrete folder UID.
 *
 * Root is excluded by construction (the caller's walk drops it and never lists it
 * in `missingParents`); the file's own leaf is a file ANCHOR, never tagged here.
 *
 * Encoding: `data = (definition = DATA_SCHEMA_UID, weight = 1)`. TAG `onAttest`
 * requires revocable=true + expirationTime 0 (EdgeResolver.sol); `refUID` is the
 * tagged target (the folder anchor), `definition` rides in `data`. `targetSchema`
 * (the ANCHOR schema) is implied on-chain by the target attestation's own schema —
 * not a field the SDK encodes.
 */
function buildVisibilityTags(input: FileWriteGraphInput, layer: number): PlannedAttestation[] {
  const { schemas } = input
  const definition = schemas.data // folder-visibility TAG definition = DATA schema UID
  const tagData = tagEncoder.encodeData([definition, VISIBILITY_TAG_WEIGHT])

  const tag = (ref: string, refUID: RefOrUID): PlannedAttestation => ({
    ref,
    layer,
    kind: 'TAG',
    schema: schemas.tag,
    data: tagData,
    revocable: true, // EdgeResolver.sol — TAG must be revocable
    refUID, // the tagged folder anchor (fresh → symbolic, existing → concrete)
    dataRefs: [],
  })

  const created = (input.missingParents ?? []).map((_segment, i) =>
    tag(REF.createdFolderTag(i), { ref: REF.parentFolder(i) }),
  )
  const existing = (input.existingAncestorTagUIDs ?? []).map((uid, i) =>
    tag(REF.existingFolderTag(i), uid),
  )
  return [...created, ...existing]
}

/**
 * The reserved-key entries to emit, in canonical order (contentType, contentHash,
 * size), skipping `contentType` when no MIME type is supplied. `contentHash` is
 * the canonical multibase-multihash string (`f1220…`, specs/10 §2.3 / SDK
 * ADR-0016); `size` is rendered as a decimal string for the PROPERTY value.
 */
function reservedEntries(
  input: FileWriteBytesInput,
): readonly { key: ReservedKey; value: string }[] {
  const out: { key: ReservedKey; value: string }[] = []
  if (input.contentType !== undefined) {
    out.push({ key: 'contentType', value: input.contentType })
  }
  out.push({ key: 'contentHash', value: input.contentHash })
  out.push({ key: 'size', value: input.size.toString() })
  return out
}
