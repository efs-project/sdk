// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// View-contract interfaces — the READ surface of the deployed EFS views.
//
// These are thin `interface` declarations of the exact deployed signatures (EFSIndexer,
// EdgeResolver, EFSFileView, ListReader) the reader forwards into. Like the writer's vendored
// EAS interfaces, they let a consumer compile against EFS reads WITHOUT importing the full
// (heavy, version-pinned) implementation contracts — only the function shapes the SDK calls.
// A consumer that already vendors the EFS contracts can pass those instances directly; the
// `address`-typed forwarders below accept any address that answers these selectors.
//
// Signatures are copied verbatim from the deployed contracts; any drift is a build break here,
// which is the intended early-warning (see the module-level note on the reader library).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// @notice The path-resolution + schema-UID read surface of `EFSIndexer` (the append-only kernel).
/// @dev    Only the members {EFSReader} forwards into are declared. `resolvePath` defaults the
///         anchor schema to Generic (`bytes32(0)`); `resolveAnchor` takes an explicit schema.
interface IEFSIndexerRead {
    function resolvePath(bytes32 parentUID, string calldata name) external view returns (bytes32);

    function resolveAnchor(bytes32 parentUID, string calldata name, bytes32 schema)
        external
        view
        returns (bytes32);

    function DATA_SCHEMA_UID() external view returns (bytes32);

    function ANCHOR_SCHEMA_UID() external view returns (bytes32);

    function PROPERTY_SCHEMA_UID() external view returns (bytes32);
}

/// @notice The cardinality-1 PIN read surface of `EdgeResolver`.
/// @dev    `SlotEntry` mirrors `EdgeResolver.SlotEntry` field-for-field; ABI decoding is
///         positional, so the layout (not the name) is what must match the deployed struct.
interface IEdgeResolverRead {
    /// @dev Mirrors `EdgeResolver.SlotEntry` (pinUID, targetID).
    struct SlotEntry {
        bytes32 pinUID;
        bytes32 targetID;
    }

    function getActivePinTarget(bytes32 definition, address attester, bytes32 targetSchema)
        external
        view
        returns (bytes32);

    function getActivePinSlot(bytes32 definition, address attester, bytes32 targetSchema)
        external
        view
        returns (SlotEntry memory);
}

/// @notice The directory-listing read surface of `EFSFileView`.
/// @dev    `FileSystemItem` and `DirectoryPage` mirror `EFSFileView`'s structs field-for-field
///         (positional ABI decode). Only {getFilesAtPath} is forwarded — the canonical
///         "list the placed files at a path, lens-scoped" page reader.
interface IEFSFileViewRead {
    /// @dev Mirrors `EFSFileView.FileSystemItem`.
    struct FileSystemItem {
        bytes32 uid;
        string name;
        bytes32 parentUID;
        bool isFolder;
        bool hasData;
        uint256 childCount;
        uint256 propertyCount;
        uint64 timestamp;
        address attester;
        bytes32 schema;
        bytes32 contentHash;
    }

    /// @dev Mirrors `EFSFileView.DirectoryPage`.
    struct DirectoryPage {
        FileSystemItem[] items;
        bytes nextCursor;
    }

    function getFilesAtPath(
        bytes32 anchorUID,
        address[] calldata attesters,
        bytes32 schema,
        bytes calldata cursor,
        uint256 maxItems
    ) external view returns (DirectoryPage memory page);
}

/// @notice The list read surface of `ListReader`.
/// @dev    `ListMode` and `Entry` mirror `IListReader`'s structs field-for-field.
interface IListReaderRead {
    /// @dev Mirrors `IListReader.ListMode`.
    struct ListMode {
        bool exists;
        address curator;
        bool allowsDuplicates;
        bool appendOnly;
        uint8 targetType;
        bytes32 targetSchema;
        uint256 maxEntries;
    }

    /// @dev Mirrors `IListReader.Entry`.
    struct Entry {
        bytes32 entryUID;
        uint8 targetType;
        bytes32 identityKey;
    }

    function getMode(bytes32 listUID) external view returns (ListMode memory);

    function length(bytes32 listUID, address attester) external view returns (uint256);

    function entries(bytes32 listUID, address attester, uint256 start, uint256 len)
        external
        view
        returns (Entry[] memory);
}

/// @title EFSReader
/// @notice Internal library for **reading** the Ethereum File System (EFS) from *your own* contract
///         — the read counterpart to {EFSLib}. Functions are `internal` so they inline into the
///         calling contract, matching the compile-in pattern (ADR-0003). Reads are pure
///         `view`/`staticcall`s, so there is no attester-identity concern as there is on the write
///         side; the inline pattern is kept for symmetry and to avoid a deployed helper hop.
///
/// @dev    NO hardcoded addresses. Every wrapper takes the relevant deployed view-contract address
///         (and schema UIDs) as parameters — the SDK's per-chain deployments registry (ADR-0005)
///         resolves these, exactly as {EFSLib} takes the schema-UID set. Pass an
///         `IEFSIndexerRead`/`IEdgeResolverRead`/`IEFSFileViewRead`/`IListReaderRead` typed from
///         the deployed view's address.
///
/// @dev    Lens-scoping: every content read is **attester-scoped** (overview.md load-bearing
///         invariant — mirrors and PROPERTYs are filtered to the lens attester at read time). The
///         wrappers therefore take the `attester` (lens) as a required parameter and never resolve
///         a "global" value; cross-attester reads are intentionally not exposed here.
///
/// @dev    Thin forwarders + ONE genuine decode. The view contracts already expose decoded reads
///         (anchor UIDs, PIN targets, `FileSystemItem`/`Entry` page items), so the wrappers forward
///         verbatim. The single piece of decoding the views do NOT hand back pre-decoded is the
///         PROPERTY string value: {propertyValue} does the `getActivePinTarget → eas.getAttestation
///         → abi.decode(string)` dance once, so consumers don't re-implement it (and get the
///         lens-scope right by construction).
library EFSReader {
    /// @dev EAS empty/uninitialized UID — "not found" for every resolution below. Mirrors
    ///      `eas-contracts/Common.sol`'s `EMPTY_UID`.
    bytes32 internal constant EMPTY_UID = bytes32(0);

    // ── Path resolution (EFSIndexer) ─────────────────────────────────────────────────────────

    /// @notice Resolve one path segment under a parent anchor to its child anchor UID, on the
    ///         Generic (`bytes32(0)`) anchor schema. Returns {EMPTY_UID} if the segment is absent.
    /// @dev    Forwards to `EFSIndexer.resolvePath`. Path-encoding is the kernel's concern; the
    ///         `name` is passed verbatim (no hashing — same invariant as the writer).
    /// @param  indexer The deployed `EFSIndexer` (read interface).
    /// @param  parentUID The parent folder anchor UID (use the EFS root anchor for a top segment).
    /// @param  name      The path segment name.
    /// @return The child anchor UID, or {EMPTY_UID} if not found.
    function resolveAnchor(IEFSIndexerRead indexer, bytes32 parentUID, string memory name)
        internal
        view
        returns (bytes32)
    {
        return indexer.resolvePath(parentUID, name);
    }

    /// @notice Resolve one path segment under a parent anchor on an explicit anchor schema.
    /// @dev    Forwards to `EFSIndexer.resolveAnchor`. Use this when the anchor was created with a
    ///         non-Generic `forSchema` (typed-anchor lookup); for the common Generic case prefer
    ///         the 3-arg {resolveAnchor} / {resolvePath}.
    /// @param  schema The anchor's `forSchema` bucket (`bytes32(0)` = Generic).
    function resolveAnchor(
        IEFSIndexerRead indexer,
        bytes32 parentUID,
        string memory name,
        bytes32 schema
    ) internal view returns (bytes32) {
        return indexer.resolveAnchor(parentUID, name, schema);
    }

    /// @notice Walk a multi-segment path from `root` to its terminal anchor UID, on the Generic
    ///         anchor schema, segment by segment. Returns {EMPTY_UID} as soon as any segment is
    ///         missing (so a non-existent path resolves to {EMPTY_UID}, never reverts).
    /// @dev    Pure composition of {resolveAnchor}: the kernel does the per-segment lookup; this is
    ///         the convenience loop so a consumer can pass `["docs","readme.txt"]` instead of
    ///         threading the intermediate UID by hand. An empty `segments` returns `root` unchanged.
    /// @param  indexer  The deployed `EFSIndexer` (read interface).
    /// @param  root     The anchor UID to start the walk from (typically the EFS root anchor).
    /// @param  segments The ordered path segments.
    /// @return anchorUID The terminal anchor UID, or {EMPTY_UID} if any segment is unresolved.
    function resolvePath(IEFSIndexerRead indexer, bytes32 root, string[] memory segments)
        internal
        view
        returns (bytes32 anchorUID)
    {
        anchorUID = root;
        uint256 n = segments.length;
        for (uint256 i = 0; i < n; ++i) {
            anchorUID = indexer.resolvePath(anchorUID, segments[i]);
            if (anchorUID == EMPTY_UID) return EMPTY_UID;
        }
    }

    // ── Active placement / PIN reads (EdgeResolver) ──────────────────────────────────────────

    /// @notice The active placement target a lens has pinned at an anchor: the DATA UID for a file
    ///         placement, or the target UID for any cardinality-1 PIN at `(anchor, attester,
    ///         schema)`. Returns {EMPTY_UID} if the lens has no active PIN in that slot.
    /// @dev    Forwards to `EdgeResolver.getActivePinTarget` (O(1)). Lens-scoped by the `attester`
    ///         parameter — this is the placement *the given attester* asserts, never a merged view.
    /// @param  edgeResolver The deployed `EdgeResolver` (read interface).
    /// @param  anchor       The anchor UID the PIN's `definition` names (e.g. the file anchor).
    /// @param  attester     The lens whose placement to read.
    /// @param  schema       The PIN slot's target schema (e.g. DATA for a file placement).
    /// @return The active target UID (DATA UID for a placement), or {EMPTY_UID}.
    function activePin(
        IEdgeResolverRead edgeResolver,
        bytes32 anchor,
        address attester,
        bytes32 schema
    ) internal view returns (bytes32) {
        return edgeResolver.getActivePinTarget(anchor, attester, schema);
    }

    /// @notice The active PIN at a slot as a `(pinUID, targetID)` tuple — when the caller also needs
    ///         the PIN attestation UID itself (e.g. to read order/label PROPERTYs bound to it), not
    ///         just the target. Both fields are {EMPTY_UID} when the slot is empty.
    /// @dev    Forwards to `EdgeResolver.getActivePinSlot`. Same lens-scoping as {activePin}.
    function activePinSlot(
        IEdgeResolverRead edgeResolver,
        bytes32 anchor,
        address attester,
        bytes32 schema
    ) internal view returns (IEdgeResolverRead.SlotEntry memory) {
        return edgeResolver.getActivePinSlot(anchor, attester, schema);
    }

    // ── PROPERTY value read (the one decode) ─────────────────────────────────────────────────

    /// @notice The decoded `string` value a lens has bound under a reserved-key anchor on a DATA —
    ///         e.g. `contentType`, `contentHash`, `size`, or `name` (ADR-0034/0049). Returns the
    ///         empty string if the lens has no active PROPERTY binding in that slot.
    /// @dev    The one genuine decode in this library, done once so consumers get it right:
    ///           1. `getActivePinTarget(keyAnchor, attester, propertySchema)` → the active PROPERTY
    ///              UID the lens bound under the key anchor (cardinality-1 binding PIN, EFSLib L197).
    ///           2. `eas.getAttestation(propertyUID)` → the PROPERTY attestation.
    ///           3. `abi.decode(att.data, (string))` → the interned value (PROPERTY schema is
    ///              `string value`; written as `abi.encode(value)` in EFSLib L191).
    ///         Lens-scoped: the binding PIN read is `attester`-scoped, so a foreign attester cannot
    ///         inject a `contentType`/`name` onto the DATA you're reading (overview.md invariant).
    ///         A zero-length PROPERTY `data` decodes to `""` safely (guarded below) rather than
    ///         reverting on a malformed/empty interned value.
    /// @param  edgeResolver   The deployed `EdgeResolver` (read interface) — resolves the binding.
    /// @param  eas            The EAS instance the PROPERTY attestation lives in.
    /// @param  keyAnchor      The reserved-key anchor UID (the binding PIN's `definition`).
    /// @param  attester       The lens whose bound value to read.
    /// @param  propertySchema The PROPERTY schema UID (the binding PIN's target schema).
    /// @return value The decoded string value, or `""` if unbound / empty.
    function propertyValue(
        IEdgeResolverRead edgeResolver,
        IEAS eas,
        bytes32 keyAnchor,
        address attester,
        bytes32 propertySchema
    ) internal view returns (string memory value) {
        bytes32 propertyUID = edgeResolver.getActivePinTarget(keyAnchor, attester, propertySchema);
        if (propertyUID == EMPTY_UID) return "";
        Attestation memory att = eas.getAttestation(propertyUID);
        // EAS permits a zero-length `data` on any schema; an unguarded abi.decode of empty bytes
        // would revert. Treat empty as the empty string (no value bound).
        if (att.data.length == 0) return "";
        value = abi.decode(att.data, (string));
    }

    // ── Directory listing (EFSFileView) ──────────────────────────────────────────────────────

    /// @notice One lens-scoped directory page: the files placed at `anchor` by any of `attesters`,
    ///         as `FileSystemItem[]` plus an opaque `nextCursor` (ADR-0036). Pass `nextCursor` back
    ///         verbatim for the next page; `nextCursor.length == 0` means fully walked.
    /// @dev    Forwards to `EFSFileView.getFilesAtPath`. `schema` is the PIN target schema to list
    ///         (DATA for files); the view requires `attesters.length` in `[1, 20]` and `max > 0`
    ///         (its own `require`s, surfaced verbatim). First-attester-wins dedup across the lens
    ///         list is done inside the view (ADR-0031).
    /// @param  fileView  The deployed `EFSFileView` (read interface).
    /// @param  anchor    The directory/file anchor UID to list placements at.
    /// @param  attesters The ordered lens list (1..20).
    /// @param  schema    The PIN target schema to list (e.g. DATA).
    /// @param  cursor    Opaque cursor from a prior page; empty bytes to start.
    /// @param  max       Target page size (must be > 0).
    /// @return page      The directory page (`items` + opaque `nextCursor`).
    function listChildren(
        IEFSFileViewRead fileView,
        bytes32 anchor,
        address[] memory attesters,
        bytes32 schema,
        bytes memory cursor,
        uint256 max
    ) internal view returns (IEFSFileViewRead.DirectoryPage memory page) {
        return fileView.getFilesAtPath(anchor, attesters, schema, cursor, max);
    }

    // ── List reads (ListReader) ──────────────────────────────────────────────────────────────

    /// @notice A page of a curated LIST's active entries for one lens (curator/contributor), in
    ///         insertion order, as `Entry[]` (no per-entry EAS read — fields come from resolver
    ///         storage).
    /// @dev    Forwards to `ListReader.entries`. Lens-scoped by `attester`: for a single-curator
    ///         list pass the curator (`listMode(...).curator`); for an open-curation list pass any
    ///         contributing attester. Pagination is NOT snapshot-isolated (ADR note on the deployed
    ///         reader).
    /// @param  listReader The deployed `ListReader` (read interface).
    /// @param  listUID    The LIST attestation UID.
    /// @param  attester   The lens whose entries to read.
    /// @param  start      Pagination offset.
    /// @param  len        Page size.
    /// @return The page of entries.
    function listEntries(
        IListReaderRead listReader,
        bytes32 listUID,
        address attester,
        uint256 start,
        uint256 len
    ) internal view returns (IListReaderRead.Entry[] memory) {
        return listReader.entries(listUID, attester, start, len);
    }

    /// @notice The number of active entries a lens has in a LIST. O(1).
    /// @dev    Forwards to `ListReader.length`.
    function listLength(IListReaderRead listReader, bytes32 listUID, address attester)
        internal
        view
        returns (uint256)
    {
        return listReader.length(listUID, attester);
    }

    /// @notice The LIST's mode/shape (existence, curator, dup policy, append-only, target type +
    ///         schema, max entries). Schema-checked before decode, so a non-LIST UID returns
    ///         `exists == false` rather than reverting.
    /// @dev    Forwards to `ListReader.getMode`. The natural first call before reading entries —
    ///         `curator` is the default lens for a single-curator list.
    function listMode(IListReaderRead listReader, bytes32 listUID)
        internal
        view
        returns (IListReaderRead.ListMode memory)
    {
        return listReader.getMode(listUID);
    }
}
