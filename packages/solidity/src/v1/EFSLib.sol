// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/// @notice The EFSIndexer WRITE surface the REDIRECT lifecycle needs (SDK ADR-0017):
///         `AliasResolver` is write-guards-only — it does NOT populate the EFSIndexer
///         referencing index that every discovery read queries (`redirects.get/list`,
///         canonicalization, history, symlink following). `index`/`indexRevocation` are the
///         permissionless follow-ups; called in the SAME transaction here, the lifecycle is
///         ATOMIC — the partial "attested but undiscoverable" state the two-transaction
///         TypeScript path must model cannot exist for a contract writer. Declared thin (like
///         the reader's view interfaces) so consumers compile without the full EFSIndexer.
interface IEFSIndexerWrite {
    function index(bytes32 uid) external;
    function indexRevocation(bytes32 uid) external;
}

/// @title EFSLib
/// @notice Internal library for **writing** the Ethereum File System (EFS) from *your own*
///         contract. Functions are `internal` so they inline into the calling contract —
///         preserving `msg.sender` as the EAS attester, which EFS lenses and cardinality-1
///         PINs depend on (ADR-0003).
///
/// @dev    The headline routine, {writeFile}, composes one logical "save this file" as the
///         full frozen-schema attestation graph (~6–13 attestations across 5 schemas) in
///         ONE transaction, threading each `eas.attest(...)`-returned UID into its dependents'
///         `refUID` / PIN `definition` **in memory**. This is exactly `SystemAccount.bootstrap`'s
///         proven pattern (sequential `eas.attest`, capture-and-thread UIDs), run *as the caller*
///         rather than as a system relay — so EAS records the caller as attester and the user
///         gets a one-signature write from their 7702 account or an app contract.
///
///         The graph (bottom-up; see planning/Designs/sdk-minimal-clicks.md "The write steps",
///         and packages/sdk/src/writes/graph.ts for the canonical TS shape):
///
///           DATA (hub, refUID 0)
///             ├─ file-ANCHOR (refUID = parent)
///             ├─ MIRROR ×N    (refUID = DATA)
///             ├─ per reserved key: key-ANCHOR (refUID = DATA) + PROPERTY (refUID 0)
///             ├─ per reserved key: binding-PIN (refUID = PROPERTY, definition = key-ANCHOR)
///             └─ placement-PIN  (refUID = DATA,      definition = file-ANCHOR)
///
///         Every `onAttest` constraint of the frozen resolvers is honored structurally (cited
///         inline at each site). recipient = 0, value = 0, expirationTime = 0 throughout.
///
/// @dev    Do NOT deploy this as a standalone helper called via a separate CALL — that would
///         make the helper the attester and collapse every consumer into one identity. It must
///         inline (internal) or run in the caller's context (DELEGATECALL).
///
/// @dev    Path-encoding invariant: this lib MUST NOT hash paths. How a path string maps to
///         on-chain identity is a protocol-contracts concern; the lib passes the already-resolved
///         parent-anchor UID and the file's anchor name through verbatim.
library EFSLib {
    /// @dev EAS empty/uninitialized UID — a `refUID` of "none". Mirrors
    ///      `eas-contracts/Common.sol`'s `EMPTY_UID`.
    bytes32 internal constant EMPTY_UID = bytes32(0);

    /// @notice {placeExisting} requires the DATA to be authored by the CALLING contract.
    /// @dev    Lens-scoped reads key a file's retrieval metadata (MIRRORs, `contentHash`/
    ///         `contentType` PROPERTYs) on the PLACEMENT attester (`resolvedBy`): a hardlink
    ///         to a foreign-authored DATA would resolve to a UID with NONE of that metadata
    ///         visible under the placer's lens — an advertised file that cannot be read or
    ///         verified. Re-publish foreign content with {writeFile} instead (attesting your
    ///         own DATA + mirrors + properties), or hardlink only your own DATA.
    error ForeignDataUID(bytes32 dataUID, address author);
    /// @dev `recipient` is always the zero address for EFS write attestations.
    address internal constant ZERO_RECIPIENT = address(0);
    /// @dev `expirationTime` is always 0 — EFS reads filter on revocation/index state, never on
    ///      EAS expiry, and several resolvers reject a nonzero `expirationTime` outright.
    uint64 internal constant NO_EXPIRATION = 0;
    /// @dev `value` is always 0 — no EFS write schema has a payable resolver.
    uint256 internal constant NO_VALUE = 0;

    /// @dev Frozen REDIRECT `kind` discriminators (ADR-0050). The taxonomy is resolver + client
    ///      convention, NOT part of the schema UID — only the field string `"bytes32 target, uint16
    ///      kind"` is frozen. `AliasResolver` type-checks the enforced kinds at write time:
    ///      sameAs/supersededBy require source + target both DATA; symlink requires source ANCHOR,
    ///      target ANCHOR-or-DATA; kinds ≥ 3 are recorded but not type-checked.
    uint16 internal constant REDIRECT_KIND_SAME_AS = 0;
    uint16 internal constant REDIRECT_KIND_SUPERSEDED_BY = 1;
    uint16 internal constant REDIRECT_KIND_SYMLINK = 2;

    /// @notice The frozen EFS schema UIDs needed to compose any EFS write. Pass the set for the
    ///         target deployment (the SDK's per-chain deployments registry resolves these).
    /// @dev    Field strings (frozen freeze set, spec 02-Data-Models-and-Schemas §; the resolvers
    ///         self-derive their UID from these so a wrong string orphans the attestation):
    ///           - `data`      → `` (empty schema, zero fields; ADR-0049)
    ///           - `anchor`    → `string name, bytes32 forSchema`
    ///           - `property`  → `string value`
    ///           - `mirror`    → `bytes32 transportDefinition, string uri`
    ///           - `pin`       → `bytes32 definition`                    (cardinality-1 edge)
    ///           - `tag`       → `bytes32 definition, int256 weight`     (cardinality-N edge)
    ///           - `list`      → `bool allowsDuplicates, bool appendOnly, uint8 targetType,
    ///                            bytes32 targetSchema, uint256 maxEntries`
    ///           - `listEntry` → `bytes32 listUID, bytes32 target`
    ///           - `redirect`  → `bytes32 target, uint16 kind`         (ADR-0050; refUID = source)
    ///         {writeFile} uses only `data`/`anchor`/`property`/`mirror`/`pin`; `tag`/`list`/
    ///         `listEntry`/`redirect` are consumed by {tag}/{createList}/{addEntry}/{setRedirect}
    ///         respectively. A caller that only does file writes may leave the other fields zero.
    struct SchemaUIDs {
        bytes32 data;
        bytes32 anchor;
        bytes32 property;
        bytes32 mirror;
        bytes32 pin;
        bytes32 tag;
        bytes32 list;
        bytes32 listEntry;
        bytes32 redirect;
    }

    /// @notice One retrieval method to publish as a MIRROR on the file's DATA.
    /// @param  transportDefinition Pre-existing `/transports/<scheme>` anchor UID
    ///         (MirrorResolver requires it to descend from the wired `/transports` anchor).
    /// @param  uri                 The retrieval URI (e.g. `ipfs://…`, `web3://…`).
    struct Mirror {
        bytes32 transportDefinition;
        string uri;
    }

    /// @notice One reserved-key metadata triplet to bind to the file's DATA.
    /// @dev    The reserved keys are `contentType`, `contentHash`, `size` (ADR-0049). Each yields
    ///         a key-ANCHOR(name=key, refUID=DATA) + PROPERTY(value) + binding-PIN(definition=
    ///         key-ANCHOR, refUID=PROPERTY). `value` is the already-stringified value (e.g. the
    ///         decimal byte length for `size`). For `contentHash` it MUST be the CANONICAL
    ///         multibase-multihash string of contracts specs/10 §2.3 — `f1220<64 lowercase hex>`
    ///         (sha2-256, the ratified default) or the `f1b20…` keccak-256 alternate. A bare
    ///         digest or `0x…`-prefixed value reads back as `malformed-claim` and never verifies
    ///         (SDK ADR-0016, superseding ADR-0006's bare-digest form).
    /// @param  key   The reserved key name (the key-ANCHOR's `name`).
    /// @param  value The interned PROPERTY value to bind under `key`.
    struct ReservedKey {
        string key;
        string value;
    }

    /// @notice All inputs to compose one file write.
    /// @param  schemas             The frozen EFS schema UID set for the target deployment.
    /// @param  parentAnchorUID     Pre-existing parent folder anchor UID (the file-ANCHOR's refUID).
    /// @param  fileName            The file's anchor name (canonical encoding; verbatim).
    /// @param  mirrors             Retrieval methods to publish (one MIRROR each). May be empty.
    /// @param  reservedKeys        Reserved-key triplets to bind (contentType/contentHash/size).
    ///         May be empty (e.g. a minimal file with no metadata).
    /// @param  existingFileAnchorUID OVERWRITE support: the pre-existing file-ANCHOR UID for this
    ///         `(parentAnchorUID, fileName)` when overwriting a path; `bytes32(0)` to mint a fresh
    ///         anchor (a new file). A file-ANCHOR is permanent/non-revocable, so re-minting the same
    ///         `(parent, name, DATA)` slot reverts (`DuplicateFileName`) — to overwrite, resolve the
    ///         existing anchor (`EFSReader.resolveAnchor(parent, fileName, schemas.data)`) and pass
    ///         it here; {writeFile} then reuses it and the new placement PIN supersedes the prior
    ///         one (cardinality-1). The DATA/MIRRORs/reserved-key PROPERTYs are always minted fresh.
    /// @dev    The file-ANCHOR's `forSchema` is ALWAYS the DATA schema UID (`schemas.data`),
    ///         never caller-supplied: the EFSIndexer keys anchors by `(parent, name, forSchema)`,
    ///         the router resolves a file's terminal segment via
    ///         `resolveAnchor(parent, name, DATA_SCHEMA_UID)`, and directory listing enumerates
    ///         only the DATA bucket — so a file MUST be DATA-typed or it lands in the folder
    ///         bucket (invisible to file listings, colliding with a same-named folder).
    struct FileWrite {
        SchemaUIDs schemas;
        bytes32 parentAnchorUID;
        string fileName;
        Mirror[] mirrors;
        ReservedKey[] reservedKeys;
        bytes32 existingFileAnchorUID;
    }

    /// @notice Compose the full file-write attestation graph in one transaction, threading the
    ///         EAS-returned UIDs in memory. `msg.sender` (the caller — because this is `internal`
    ///         and inlines) is recorded by EAS as the attester of every node.
    /// @dev    Order matters: each `eas.attest` writes to EAS's `_db` before the next call, and a
    ///         dependent node references the just-mined UID by value (no forward references). The
    ///         DATA UID is the hub; the file-ANCHOR and key-ANCHORs are minted before the PINs
    ///         that name them as `definition`.
    /// @param  eas The EAS instance to attest against.
    /// @param  w   The file-write inputs.
    /// @return dataUID          The created DATA (file identity) UID.
    /// @return fileAnchorUID    The created file-ANCHOR UID (the placement PIN's `definition`).
    /// @return placementPinUID  The created placement-PIN UID (what makes the file appear at the path).
    function writeFile(IEAS eas, FileWrite memory w)
        internal
        returns (bytes32 dataUID, bytes32 fileAnchorUID, bytes32 placementPinUID)
    {
        // ── L1: DATA — the content-identity hub ──────────────────────────────────────────────
        // EFSIndexer.onAttest DATA branch: refUID must be EMPTY_UID, non-revocable,
        // expirationTime 0, and EMPTY data (EFSIndexer.sol:472-475). The empty schema encodes to
        // "" — pass empty bytes.
        dataUID = eas.attest(
            AttestationRequest({
                schema: w.schemas.data,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT,
                    expirationTime: NO_EXPIRATION,
                    revocable: false, // EFSIndexer.sol:473 — rejects revocable
                    refUID: EMPTY_UID, // EFSIndexer.sol:472 — refUID must be EMPTY_UID
                    data: "", // EFSIndexer.sol:475 — data.length must be 0
                    value: NO_VALUE
                })
            })
        );

        // ── L2: file-ANCHOR — names the path under the parent folder ──────────────────────────
        // EFSIndexer ANCHOR branch: non-revocable (:376), expirationTime 0 (:380), parent
        // resolved from refUID (:396). data = abi.encode(name, forSchema). forSchema is the
        // DATA schema UID (NOT generic) — a file slot is `(parent, name, DATA_SCHEMA_UID)`;
        // a generic file would land in the folder bucket and miss file listings.
        //
        // OVERWRITE: reuse the caller-supplied existing file-ANCHOR when set (a permanent
        // anchor slot can't be re-minted — that reverts). The placement PIN below then
        // supersedes the prior placement (cardinality-1). Else mint a fresh anchor.
        fileAnchorUID = w.existingFileAnchorUID != EMPTY_UID
            ? w.existingFileAnchorUID
            : _attestAnchor(eas, w.schemas.anchor, w.fileName, w.schemas.data, w.parentAnchorUID);

        // ── L2: MIRROR ×N — retrieval methods bound to DATA ───────────────────────────────────
        // MirrorResolver.onAttest: refUID must resolve to a DATA attestation (:154-157),
        // revocable=true (:164), expirationTime 0 (:165). data = (transportDefinition, uri).
        uint256 mlen = w.mirrors.length;
        for (uint256 i = 0; i < mlen; ++i) {
            Mirror memory m = w.mirrors[i];
            eas.attest(
                AttestationRequest({
                    schema: w.schemas.mirror,
                    data: AttestationRequestData({
                        recipient: ZERO_RECIPIENT,
                        expirationTime: NO_EXPIRATION,
                        revocable: true, // MirrorResolver.sol:164 — must be revocable
                        refUID: dataUID, // MirrorResolver.sol:154-157 — refUID must be a DATA attestation
                        data: abi.encode(m.transportDefinition, m.uri),
                        value: NO_VALUE
                    })
                })
            );
        }

        // ── L2 + L3: reserved-key triplets (key-ANCHOR + PROPERTY + binding-PIN) ───────────────
        uint256 klen = w.reservedKeys.length;
        for (uint256 i = 0; i < klen; ++i) {
            ReservedKey memory rk = w.reservedKeys[i];

            // L2 key-ANCHOR: name = the reserved key, refUID = DATA (binds the metadata anchor to
            // the file identity). forSchema MUST be the PROPERTY schema UID — it is the third key of
            // the EFSIndexer anchor directory (_nameToAnchor[parent][name][forSchema], :432/:527), so
            // a property key-anchor written under a generic forSchema lands in a different slot and is
            // invisible to every spec-conformant reader, incl. EFSRouter._getContentType (which
            // resolves contentType via resolveAnchor(DATA, key, PROPERTY_SCHEMA_UID)). Matches
            // graph.ts, which writes the key-anchor with schemas.property. (Generic forSchema is for
            // plain folder/file path nodes only — see {anchorAt}.)
            bytes32 keyAnchorUID =
                _attestAnchor(eas, w.schemas.anchor, rk.key, w.schemas.property, dataUID);

            // L2 PROPERTY + L3 binding-PIN: the interned value (refUID 0, non-revocable) plus the
            // cardinality-1 PIN(definition = key-ANCHOR, refUID = PROPERTY) — same triple
            // {setProperty} composes, shared via {_bindProperty}.
            _bindProperty(eas, w.schemas, keyAnchorUID, rk.value);
        }

        // ── L3: placement-PIN — definition = file-ANCHOR (fresh), refUID = DATA (fresh) ───────
        // This is what makes the file appear at the path. EdgeResolver PIN requires revocable=true
        // and expirationTime 0; cardinality-1 — re-attesting at the same (attester, definition,
        // targetSchema) slot supersedes the caller's prior placement in O(1).
        placementPinUID = _attestPin(eas, w.schemas.pin, fileAnchorUID, dataUID);
    }

    /// @notice Hardlink / dedup short-circuit: place an already-existing DATA at a new path with a
    ///         single placement PIN (and the file-ANCHOR that names the new path).
    /// @dev    "Add an existing file at a new path" (or re-upload of identical bytes the caller
    ///         already resolved to an on-chain DATA UID) reuses that DATA and collapses the whole
    ///         content graph (DATA/MIRROR/PROPERTY/key-anchors) away. The file-ANCHOR is still
    ///         minted — it names the new path — and the placement PIN points its `refUID` at the
    ///         pre-existing DATA (graph.ts hardlink branch).
    /// @param  eas             The EAS instance to attest against.
    /// @param  schemas         The frozen schema UID set (`anchor`, `pin`, `data` are used).
    /// @param  dataUID         The pre-existing DATA UID to place.
    /// @param  parentAnchorUID Pre-existing parent folder anchor UID (the file-ANCHOR's refUID).
    /// @param  fileName        The file's anchor name (verbatim).
    /// @return fileAnchorUID   The created file-ANCHOR UID.
    /// @return placementPinUID The created placement-PIN UID.
    /// @dev    The file-ANCHOR's `forSchema` is the DATA schema UID (a file slot is
    ///         `(parent, name, DATA_SCHEMA_UID)`), NOT generic — same rule as {writeFile}.
    ///         This form always MINTS the file-ANCHOR, so it is "place at a NEW path". To
    ///         RE-point an existing path (overwrite/relink), resolve the slot first
    ///         (`EFSReader.resolveAnchor(parent, name, schemas.data)`) and pass it to the
    ///         6-arg overload — re-minting the permanent `(parent, name, DATA)` anchor
    ///         reverts (DuplicateFileName) or files a non-canonical anchor the read path
    ///         never finds. Mirrors {writeFile}'s `existingFileAnchorUID`.
    function placeExisting(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 dataUID,
        bytes32 parentAnchorUID,
        string memory fileName
    ) internal returns (bytes32 fileAnchorUID, bytes32 placementPinUID) {
        return placeExisting(eas, schemas, dataUID, parentAnchorUID, fileName, EMPTY_UID);
    }

    /// @notice {placeExisting} that REUSES an already-resolved file-ANCHOR — the overwrite /
    ///         relink form, so re-pointing an existing path does not re-mint its permanent anchor.
    /// @dev    When `existingFileAnchorUID != EMPTY_UID` the file-ANCHOR is reused (no mint) and
    ///         only the cardinality-1 placement PIN is attested — the PIN supersedes the prior
    ///         placement at `(attester, anchor, DATA)` in O(1). When `EMPTY_UID`, behaves exactly
    ///         like the 5-arg form (mints a fresh file-ANCHOR for a NEW path). Resolve the anchor
    ///         via `EFSReader.resolveAnchor(parentAnchorUID, fileName, schemas.data)` (⇒ {EMPTY_UID}
    ///         when the path is new).
    /// @param  existingFileAnchorUID The pre-resolved file-ANCHOR to reuse, or {EMPTY_UID} to mint.
    /// @dev    Reverts {ForeignDataUID} unless `dataUID` was authored by the calling contract —
    ///         the shortcut reuses the author's existing MIRROR/PROPERTY metadata, which only
    ///         resolves under the placer's lens when placer == author.
    function placeExisting(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 dataUID,
        bytes32 parentAnchorUID,
        string memory fileName,
        bytes32 existingFileAnchorUID
    ) internal returns (bytes32 fileAnchorUID, bytes32 placementPinUID) {
        // Self-authorship gate: the hardlink shortcut reuses the DATA's EXISTING
        // retrieval metadata, which lens-scoped reads resolve per-attester — so it
        // only works when the placer IS the author (the metadata then applies to
        // the new placement automatically). See {ForeignDataUID}.
        Attestation memory att = eas.getAttestation(dataUID);
        if (att.attester != address(this)) revert ForeignDataUID(dataUID, att.attester);
        fileAnchorUID = existingFileAnchorUID != EMPTY_UID
            ? existingFileAnchorUID
            : _attestAnchor(eas, schemas.anchor, fileName, schemas.data, parentAnchorUID);
        placementPinUID = _attestPin(eas, schemas.pin, fileAnchorUID, dataUID);
    }

    // ── primitive write wrappers (mkdir / tag / property / place / list) ─────────────────────

    /// @notice The **mkdir** primitive: mint a child ANCHOR (a folder/name node) under a parent.
    /// @dev    An ANCHOR *is* the folder/name node — there is no separate "directory" object in EFS;
    ///         a folder is just an anchor that other anchors and placements hang off. This is the
    ///         same node {writeFile} mints for the file-ANCHOR, exposed standalone so a contract can
    ///         create intermediate path segments (the `mkdir -p` building block) before placing
    ///         files under them.
    ///
    ///         EFSIndexer ANCHOR branch: non-revocable, expirationTime 0, parent resolved from
    ///         `refUID`, `data = abi.encode(name, forSchema)`. The new anchor's identity is
    ///         deterministic in `(parentAnchor, name, forSchema, attester)` at the kernel, so
    ///         re-attesting the same child is idempotent at resolution time (the kernel returns the
    ///         canonical anchor); this wrapper always mints, returning the fresh UID. Resolve first
    ///         with {EFSReader.resolveAnchor} if you want create-or-return semantics without a write.
    /// @param  eas          The EAS instance to attest against.
    /// @param  schemas      The frozen schema UID set (only `anchor` is used).
    /// @param  parentAnchor The parent folder anchor UID (the new anchor's `refUID`).
    /// @param  name         The child anchor's name (verbatim — the lib never hashes paths).
    /// @return anchorUID    The created (child) ANCHOR UID.
    function anchorAt(IEAS eas, SchemaUIDs memory schemas, bytes32 parentAnchor, string memory name)
        internal
        returns (bytes32 anchorUID)
    {
        // Generic forSchema (bytes32(0)) — a plain folder/name node, matching graph.ts
        // GENERIC_FOR_SCHEMA. A typed-anchor caller can use the 5-arg overload below.
        anchorUID = _attestAnchor(eas, schemas.anchor, name, EMPTY_UID, parentAnchor);
    }

    /// @notice {anchorAt} with an explicit `forSchema` content-type bucket (typed-anchor variant).
    /// @dev    Use when the anchor must live in a non-Generic content-type bucket (the kernel keys
    ///         anchors by `(parent, name, forSchema)`, so a typed anchor is distinct from the Generic
    ///         one of the same name). Plain folders should use the 4-arg form.
    function anchorAt(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 parentAnchor,
        string memory name,
        bytes32 forSchema
    ) internal returns (bytes32 anchorUID) {
        anchorUID = _attestAnchor(eas, schemas.anchor, name, forSchema, parentAnchor);
    }

    /// @notice A **TAG** edge (cardinality-N): assert `definition`-categorized membership of `target`
    ///         with a `weight`. The folder-visibility / label primitive.
    /// @dev    EdgeResolver TAG branch (`EdgeResolver.sol`): schema = `bytes32 definition, int256
    ///         weight`; `data = abi.encode(definition, weight)` (definition first, weight second —
    ///         exactly 64 bytes, no padding or the resolver reverts `NonCanonicalPayload`). The edge
    ///         must be `revocable=true` with `expirationTime 0` (resolver `NotRevocable`/
    ///         `HasExpiration`). The *target* of the edge is the native EAS `refUID` (an existing
    ///         attestation UID), NOT a payload field — matching `_resolveTargetID(refUID, recipient)`
    ///         which uses `refUID` when nonzero. `definition` is the predicate/category (e.g. a DATA
    ///         schema UID for folder visibility, or a `/tags/<name>` anchor UID for a label) and must
    ///         pass `_validateDefinition` (nonzero, and an address / registered-schema / existing
    ///         attestation). Cardinality-N: each `(attester, target, definition)` is its own edge —
    ///         re-tagging the same triple does not supersede, it adds.
    /// @param  eas        The EAS instance to attest against.
    /// @param  schemas    The frozen schema UID set (only `tag` is used).
    /// @param  target     The attestation UID being tagged (the edge's `refUID`).
    /// @param  definition The tag predicate/category (validated by the resolver; must be nonzero).
    /// @param  weight     The signed tag weight (e.g. ordering / score; may be 0 or negative).
    /// @return tagUID     The created TAG edge UID.
    function tag(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 target,
        bytes32 definition,
        int256 weight
    ) internal returns (bytes32 tagUID) {
        tagUID = eas.attest(
            AttestationRequest({
                schema: schemas.tag,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT,
                    expirationTime: NO_EXPIRATION,
                    revocable: true, // EdgeResolver — TAG must be revocable
                    refUID: target, // edge target via native refUID (_resolveTargetID)
                    data: abi.encode(definition, weight), // (definition, weight) — 64 bytes exact
                    value: NO_VALUE
                })
            })
        );
    }

    /// @notice Set an arbitrary key/value **PROPERTY** triple on a DATA — generalizing the reserved-
    ///         key triplet {writeFile} writes internally (contentType/contentHash/size) to any key.
    /// @dev    The triple is: a key-ANCHOR(name = `keyName`, refUID = `dataUID`) that names the slot
    ///         under the DATA + a free-floating PROPERTY(value) (refUID 0, non-revocable) + a binding
    ///         PIN(definition = key-ANCHOR, refUID = PROPERTY) that links them, exactly as EFSLib
    ///         L176-L200 does for reserved keys. The binding PIN is cardinality-1, so re-setting the
    ///         same `(dataUID, keyName)` for the same attester supersedes the prior value in O(1)
    ///         (the read side, {EFSReader.propertyValue}, returns the lens's active binding).
    ///
    ///         Pass the existing key-ANCHOR UID via {setProperty}'s 6-arg overload to avoid re-minting
    ///         it; this 5-arg form always mints the key-ANCHOR (create-or-set without a prior read).
    /// @param  eas      The EAS instance to attest against.
    /// @param  schemas  The frozen schema UID set (`anchor`, `property`, `pin` are used).
    /// @param  dataUID  The DATA the property is bound under (the key-ANCHOR's `refUID`).
    /// @param  keyName  The property key (the key-ANCHOR's `name`; verbatim).
    /// @param  value    The stringified property value (interned in the PROPERTY).
    /// @return keyAnchorUID The created key-ANCHOR UID (the binding PIN's `definition`).
    /// @return propertyUID  The created PROPERTY UID (the interned value).
    /// @return bindingPinUID The created binding-PIN UID (what makes the value the active one).
    function setProperty(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 dataUID,
        string memory keyName,
        string memory value
    ) internal returns (bytes32 keyAnchorUID, bytes32 propertyUID, bytes32 bindingPinUID) {
        // L2 key-ANCHOR: name = key, refUID = DATA, forSchema = PROPERTY schema UID. forSchema is the
        // third key of the EFSIndexer anchor directory (:432/:527), so it MUST be schemas.property —
        // a generic forSchema files the property under a different slot, invisible to spec-conformant
        // readers (EFSRouter, graph.ts/props.get). Generic forSchema is for folder/file nodes only.
        keyAnchorUID = _attestAnchor(eas, schemas.anchor, keyName, schemas.property, dataUID);
        (propertyUID, bindingPinUID) = _bindProperty(eas, schemas, keyAnchorUID, value);
    }

    /// @notice {setProperty} against an already-minted key-ANCHOR — set/replace the value at a known
    ///         slot without re-minting the key-ANCHOR.
    /// @dev    Mints only the PROPERTY + binding PIN (the cardinality-1 supersede). Use after a
    ///         {EFSReader.resolveAnchor}/{anchorAt} that produced the key-ANCHOR, e.g. to update a
    ///         value you previously set.
    /// @param  keyAnchorUID The pre-existing key-ANCHOR UID (slot under the DATA).
    /// @return propertyUID  The created PROPERTY UID.
    /// @return bindingPinUID The created binding-PIN UID.
    function setPropertyAt(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 keyAnchorUID,
        string memory value
    ) internal returns (bytes32 propertyUID, bytes32 bindingPinUID) {
        (propertyUID, bindingPinUID) = _bindProperty(eas, schemas, keyAnchorUID, value);
    }

    /// @notice A placement **PIN** (cardinality-1): bind `dataUID` at `anchor` under the caller — the
    ///         hardlink / move primitive. Makes the DATA appear at the path the anchor names.
    /// @dev    EdgeResolver PIN: schema = `bytes32 definition`; `data = abi.encode(definition)` where
    ///         `definition` is the *anchor* (the path node); `refUID` is the *target* DATA. revocable
    ///         =true, expirationTime 0. Cardinality-1: re-placing at the same `(attester, anchor, DATA
    ///         schema)` slot supersedes the caller's prior placement in O(1) — that is "move". This is
    ///         the standalone placement {writeFile}/{placeExisting} compose internally, exposed for a
    ///         caller that already has both the anchor and the DATA UID (e.g. relinking an existing
    ///         file, or re-pointing a path at different content).
    /// @param  eas     The EAS instance to attest against.
    /// @param  schemas The frozen schema UID set (only `pin` is used).
    /// @param  anchor  The path anchor UID the placement names (the PIN's `definition`).
    /// @param  dataUID The DATA UID being placed (the PIN's `refUID` / edge target).
    /// @return pinUID  The created placement-PIN UID.
    function place(IEAS eas, SchemaUIDs memory schemas, bytes32 anchor, bytes32 dataUID)
        internal
        returns (bytes32 pinUID)
    {
        pinUID = _attestPin(eas, schemas.pin, anchor, dataUID);
    }

    /// @notice Create a curated **LIST** (ADR-0044/0046/0047): a free-floating list object whose
    ///         entries are added with {addEntry}.
    /// @dev    ListResolver: schema = `bool allowsDuplicates, bool appendOnly, uint8 targetType,
    ///         bytes32 targetSchema, uint256 maxEntries`; `data = abi.encode(allowsDuplicates,
    ///         appendOnly, targetType, targetSchema, maxEntries)` (exactly 160 bytes). The LIST is
    ///         **non-revocable**, **free-floating** (`refUID` 0), **undirected** (`recipient` 0), with
    ///         `expirationTime 0` (all enforced by the resolver). `targetType`: 0 = ANY (opaque keys),
    ///         1 = ADDR (address members), 2 = SCHEMA (attestations of `targetSchema`). For SCHEMA,
    ///         `targetSchema` must be nonzero; for ANY/ADDR it must be zero. If both `appendOnly` and
    ///         `allowsDuplicates`, `maxEntries` must be nonzero (resolver requires the cap). The
    ///         curator is the attester (the caller) — there is no curator payload field.
    /// @param  eas             The EAS instance to attest against.
    /// @param  schemas         The frozen schema UID set (only `list` is used).
    /// @param  allowsDuplicates Whether the same member may appear more than once.
    /// @param  appendOnly      Whether entries may never be revoked.
    /// @param  targetType      0 = ANY, 1 = ADDR, 2 = SCHEMA.
    /// @param  targetSchema    For SCHEMA (2): the required entry schema (nonzero). Else `bytes32(0)`.
    /// @param  maxEntries      Entry cap (0 = uncapped; required nonzero when appendOnly+duplicates).
    /// @return listUID         The created LIST UID (pass to {addEntry}).
    function createList(
        IEAS eas,
        SchemaUIDs memory schemas,
        bool allowsDuplicates,
        bool appendOnly,
        uint8 targetType,
        bytes32 targetSchema,
        uint256 maxEntries
    ) internal returns (bytes32 listUID) {
        listUID = eas.attest(
            AttestationRequest({
                schema: schemas.list,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT, // ListResolver — must be undirected
                    expirationTime: NO_EXPIRATION, // ListResolver — must not expire
                    revocable: false, // ListResolver — LIST must be non-revocable
                    refUID: EMPTY_UID, // ListResolver — LIST must be free-floating
                    data: abi.encode(
                        allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries
                    ),
                    value: NO_VALUE
                })
            })
        );
    }

    /// @notice Add an entry to a LIST — a **LIST_ENTRY** referencing the LIST by its payload `listUID`
    ///         field (NOT by `refUID`), for the ANY (0) / SCHEMA (2) target modes.
    /// @dev    ListEntryResolver: schema = `bytes32 listUID, bytes32 target`; `data =
    ///         abi.encode(listUID, target)` (exactly 64 bytes). **`refUID` MUST be 0** — the LIST is
    ///         referenced via the `listUID` payload field, and a nonzero `refUID` reverts
    ///         (`UsesRefUID`). The entry is `revocable=true` with `expirationTime 0`. `target` is the
    ///         member key: for ANY it is any nonzero opaque key; for SCHEMA it is the target
    ///         attestation UID (which must exist and match the LIST's `targetSchema`). This wrapper
    ///         keeps `recipient = 0`, so it does NOT cover the ADDR (1) mode, whose member address
    ///         lives in `recipient` and whose `target` must be zero — use {addAddressEntry} for that.
    /// @param  eas      The EAS instance to attest against.
    /// @param  schemas  The frozen schema UID set (only `listEntry` is used).
    /// @param  listUID  The LIST this entry joins (payload field; the resolver re-fetches it).
    /// @param  target   The nonzero member key (ANY: opaque key; SCHEMA: target attestation UID).
    /// @return entryUID The created LIST_ENTRY UID.
    function addEntry(IEAS eas, SchemaUIDs memory schemas, bytes32 listUID, bytes32 target)
        internal
        returns (bytes32 entryUID)
    {
        entryUID = eas.attest(
            AttestationRequest({
                schema: schemas.listEntry,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT, // ANY/SCHEMA modes require recipient 0
                    expirationTime: NO_EXPIRATION, // ListEntryResolver — must be 0
                    revocable: true, // ListEntryResolver — must be revocable
                    refUID: EMPTY_UID, // ListEntryResolver — refUID MUST be 0 (UsesRefUID)
                    data: abi.encode(listUID, target), // (listUID, target) — 64 bytes exact
                    value: NO_VALUE
                })
            })
        );
    }

    /// @notice Add an **ADDR-mode** (targetType 1) LIST entry: the member is an address carried in
    ///         the native EAS `recipient`, with the payload `target` field forced to zero.
    /// @dev    The one EFS write whose `recipient` is intentionally nonzero — ADDR-mode LIST_ENTRY is
    ///         the protocol's address-target form (ListEntryResolver `BadAddrMode` requires payload
    ///         `target == 0`, and derives the identity key from `recipient`). Kept distinct from
    ///         {addEntry} so the zero-recipient invariant of the rest of the lib stays explicit.
    /// @param  member The address member (the entry's `recipient`; address(0) is a valid ADDR entry).
    /// @return entryUID The created LIST_ENTRY UID.
    function addAddressEntry(IEAS eas, SchemaUIDs memory schemas, bytes32 listUID, address member)
        internal
        returns (bytes32 entryUID)
    {
        entryUID = eas.attest(
            AttestationRequest({
                schema: schemas.listEntry,
                data: AttestationRequestData({
                    recipient: member, // ADDR mode — member address lives in recipient
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: EMPTY_UID, // refUID MUST be 0
                    data: abi.encode(listUID, bytes32(0)), // ADDR mode — payload target MUST be 0
                    value: NO_VALUE
                })
            })
        );
    }

    /// @notice A **REDIRECT** edge (ADR-0050): assert that `source` points at `target` with class
    ///         `kind` — the trust-scoped "this points at that" primitive for canonical/dedup
    ///         (`sameAs`), version supersession (`supersededBy`), and path symlinks (`symlink`).
    /// @dev    `AliasResolver.onAttest`: schema = `bytes32 target, uint16 kind`; `data =
    ///         abi.encode(target, kind)` (exactly 64 bytes — `uint16` pads to a word; a wrong length
    ///         reverts `BadPayload`). The *source* is the native EAS `refUID` (the duplicate DATA for
    ///         sameAs/supersededBy; the path ANCHOR for symlink), NOT a payload field. The edge MUST
    ///         be `revocable=true` with `expirationTime 0` (resolver `NotRevocable`/`HasExpiration`;
    ///         a redirect is "active until explicitly revoked"). Write-time guards: `target != 0`
    ///         (`ZeroTarget`), `target != source` (`SelfLoop` — no trivial direct self-loop), and
    ///         per-kind typing (sameAs/supersededBy require source + target both DATA; symlink
    ///         requires source ANCHOR, target ANCHOR-or-DATA; kinds ≥ 3 are recorded, not typed).
    ///         Multi-hop cycle handling, depth caps, and chain-following are READ-time concerns
    ///         (see {EFSReader.resolveWithRedirects}) — the resolver does not walk the graph.
    ///
    ///         Cardinality note: REDIRECT is NOT a cardinality-1 slot like PIN. The resolver stores
    ///         no `(source, attester)` slot and does not supersede a prior redirect — re-attesting
    ///         adds another redirect edge. To replace or remove a redirect, `eas.revoke()` the prior
    ///         REDIRECT UID (which is why this returns it). This is unlike {place}/{anchorAt}, whose
    ///         cardinality-1 PIN supersedes in O(1).
    /// @param  eas     The EAS instance to attest against.
    /// @param  indexer The EFSIndexer — the SAME-tx `index(uid)` leg that makes the redirect
    ///                 discoverable (see {IEFSIndexerWrite}; ADR-0017).
    /// @param  schemas The frozen schema UID set (only `redirect` is used).
    /// @param  source  The source UID this redirect points FROM (the edge's `refUID`).
    /// @param  target  The destination UID this redirect points TO (nonzero, != source).
    /// @param  kind    The redirect class (0 = sameAs, 1 = supersededBy, 2 = symlink; ≥ 3 reserved).
    /// @return redirectUID The created REDIRECT edge UID ({removeRedirect} it to retract —
    ///         a bare `eas.revoke()` leaves the revocation UNMIRRORED in the indexer, so the
    ///         redirect keeps being served by filtered reads).
    function setRedirect(
        IEAS eas,
        IEFSIndexerWrite indexer,
        SchemaUIDs memory schemas,
        bytes32 source,
        bytes32 target,
        uint16 kind
    ) internal returns (bytes32 redirectUID) {
        redirectUID = eas.attest(
            AttestationRequest({
                schema: schemas.redirect,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT,
                    expirationTime: NO_EXPIRATION, // AliasResolver — HasExpiration if nonzero
                    revocable: true, // AliasResolver — NotRevocable if false
                    refUID: source, // source via native refUID (the redirect's `refUID`)
                    data: abi.encode(target, kind), // (target, kind) — 64 bytes exact
                    value: NO_VALUE
                })
            })
        );
        // Complete the ADR-0017 lifecycle ATOMICALLY: AliasResolver never populates
        // the referencing index the discovery reads query, so without this same-tx
        // leg the redirect exists in EAS but is INVISIBLE to every SDK reader until
        // someone manually repairs it (`efs.index(uid)`).
        indexer.index(redirectUID);
    }

    /// @notice Retract a REDIRECT: `eas.revoke` the edge AND mirror the revocation into the
    ///         EFSIndexer — ADR-0017's second leg. Without `indexRevocation` the revoked
    ///         redirect KEEPS BEING SERVED by the filtered discovery reads (the index is
    ///         append-only and revocation-filtered per its own mirror, not per EAS). Both
    ///         legs run in THIS transaction, so the stale-mirror window cannot exist.
    /// @param  eas         The EAS instance to revoke against.
    /// @param  indexer     The EFSIndexer (the revocation-mirror leg).
    /// @param  schemas     The frozen schema UID set (only `redirect` is used).
    /// @param  redirectUID The REDIRECT edge UID to retract.
    function removeRedirect(
        IEAS eas,
        IEFSIndexerWrite indexer,
        SchemaUIDs memory schemas,
        bytes32 redirectUID
    ) internal {
        eas.revoke(
            RevocationRequest({
                schema: schemas.redirect,
                data: RevocationRequestData({uid: redirectUID, value: NO_VALUE})
            })
        );
        // Same-tx mirror: EAS state is already updated within this transaction, so
        // the indexer's "revoked in EAS" precondition holds.
        indexer.indexRevocation(redirectUID);
    }

    // ── internal attest helpers (one per node shape) ─────────────────────────────────────────

    /// @dev Attest an ANCHOR. Non-revocable, expiration 0, parent via refUID, data =
    ///      abi.encode(name, forSchema). EFSIndexer ANCHOR branch (:376/:380/:396).
    function _attestAnchor(
        IEAS eas,
        bytes32 anchorSchema,
        string memory name,
        bytes32 forSchema,
        bytes32 parentUID
    ) private returns (bytes32) {
        return eas.attest(
            AttestationRequest({
                schema: anchorSchema,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT,
                    expirationTime: NO_EXPIRATION,
                    revocable: false, // EFSIndexer.sol:376 — anchors are non-revocable
                    refUID: parentUID, // EFSIndexer.sol:396 — parent resolved from refUID
                    data: abi.encode(name, forSchema),
                    value: NO_VALUE
                })
            })
        );
    }

    /// @dev Attest a PIN. Revocable, expiration 0, refUID = the edge target (DATA or PROPERTY),
    ///      data = abi.encode(definition) (an anchor UID). EdgeResolver PIN branch.
    function _attestPin(IEAS eas, bytes32 pinSchema, bytes32 definition, bytes32 refUID)
        private
        returns (bytes32)
    {
        return eas.attest(
            AttestationRequest({
                schema: pinSchema,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT,
                    expirationTime: NO_EXPIRATION,
                    revocable: true, // EdgeResolver — PIN must be revocable
                    refUID: refUID, // edge target: DATA (placement) or PROPERTY (binding)
                    data: abi.encode(definition),
                    value: NO_VALUE
                })
            })
        );
    }

    /// @dev Mint the value half of a PROPERTY triple against an existing key-ANCHOR: a free-floating
    ///      PROPERTY(value) (refUID 0, non-revocable — EFSIndexer PROPERTY branch) plus the binding
    ///      PIN(definition = key-ANCHOR, refUID = PROPERTY) that makes it the active value. Shared by
    ///      {writeFile}'s reserved-key loop and {setProperty}/{setPropertyAt}.
    function _bindProperty(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 keyAnchorUID,
        string memory value
    ) private returns (bytes32 propertyUID, bytes32 bindingPinUID) {
        // L2 PROPERTY: the interned value. refUID≠0 and revocable are both rejected by the kernel.
        propertyUID = eas.attest(
            AttestationRequest({
                schema: schemas.property,
                data: AttestationRequestData({
                    recipient: ZERO_RECIPIENT,
                    expirationTime: NO_EXPIRATION,
                    revocable: false, // EFSIndexer PROPERTY branch — rejects revocable
                    refUID: EMPTY_UID, // EFSIndexer PROPERTY branch — refUID must be EMPTY_UID
                    data: abi.encode(value),
                    value: NO_VALUE
                })
            })
        );
        // L3 binding-PIN: definition = key-ANCHOR, refUID = PROPERTY (cardinality-1 supersede).
        bindingPinUID = _attestPin(eas, schemas.pin, keyAnchorUID, propertyUID);
    }
}
