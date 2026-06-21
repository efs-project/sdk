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

    // ── REDIRECT (ADR-0050) ──────────────────────────────────────────────────────────────────
    //
    // Frozen REDIRECT kind discriminators (taxonomy is resolver + client convention, NOT part of
    // the schema UID — ADR-0050; mirrored from `AliasResolver`). Read-time *follow* rules:
    // sameAs / supersededBy / symlink are auto-followed; `relatedVersion` (3) and any other
    // reserved kind are NEVER auto-followed (the SKOS guard against "sameAs explosion").
    uint16 internal constant REDIRECT_KIND_SAME_AS = 0;
    uint16 internal constant REDIRECT_KIND_SUPERSEDED_BY = 1;
    uint16 internal constant REDIRECT_KIND_SYMLINK = 2;
    uint16 internal constant REDIRECT_KIND_RELATED_VERSION = 3;

    /// @dev Default hop cap for {resolveWithRedirects} when a caller passes `0` — the soft ceiling
    ///      `D_MAX ≈ 8` from ADR-0050 §"Write-time guards vs read-time resolution". The hard
    ///      ceiling is `MAX_ANCHOR_DEPTH` (32, ADR-0021); callers may pass any explicit cap up to
    ///      that, but the on-chain follower never loops unbounded (see {RedirectHopLimit}).
    uint256 internal constant REDIRECT_DEFAULT_MAX_HOPS = 8;

    /// @dev Hard ceiling on the redirect hop cap (MAX_ANCHOR_DEPTH, 32; ADR-0021), matching the
    ///      TS reader. {resolveWithRedirects} CLAMPS `maxHops` to this so a hostile/huge value
    ///      can't overflow `cap + 1` or force an enormous `visited` allocation.
    uint256 internal constant REDIRECT_MAX_HOPS = 32;

    /// @notice Raised when following a redirect chain detects a cycle — the same source is visited
    ///         twice (e.g. A→B by one lens, B→A by another). The contracts cannot self-loop a
    ///         single redirect (`AliasResolver` rejects `target == refUID`), but multi-hop cycles
    ///         across attesters are a read-time concern resolved here, not on-chain (ADR-0050).
    error RedirectCycle(bytes32 atSource);

    /// @notice Raised when a redirect chain exceeds the hop cap before reaching a terminal target —
    ///         the bounded-walk guard that replaces an unbounded loop.
    error RedirectHopLimit(uint256 maxHops);

    /// @notice Raised when a redirect UID supplied in a follow chain does not connect: its decoded
    ///         source (`refUID`) is not the cursor the walk currently sits on. Surfaces a malformed
    ///         caller-supplied chain rather than silently following an unrelated redirect.
    error RedirectChainBroken(bytes32 expectedSource, bytes32 redirectUID);

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

    // ── REDIRECT resolution (ADR-0050) ─────────────────────────────────────────────────────────
    //
    // The model (verified against the deployed contracts): a REDIRECT is a plain EAS attestation —
    // `refUID` = the *source* (a DATA for sameAs/supersededBy, an ANCHOR for symlink), `data =
    // abi.encode(bytes32 target, uint16 kind)`, and the EAS `attester` is the asserting *lens*.
    // `AliasResolver` enforces write-time guards ONLY (no self-loop, per-kind typing) and stores
    // NOTHING: there is no on-chain `(source, attester)` active-redirect slot the way `EdgeResolver`
    // has one for PINs, reverse fan-in ("what points at me?") is intentionally un-indexed on-chain,
    // and `EFSFileView.getCanonicalData` is a deprecated no-op. NOTHING on-chain follows redirects —
    // multi-hop following, cycle handling, and the hop cap are read-time logic (ADR-0050
    // §"Write-time guards vs read-time resolution"), which is what this section provides.
    //
    // Consequence for the API: because there is no source→redirect index on-chain, a pure on-chain
    // reader cannot *discover* which redirect applies at a source — the off-chain indexer (or the
    // caller's own knowledge) supplies the candidate redirect UID(s). The reader's job is to
    // AUTHORITATIVELY decode each supplied redirect (right schema, asserted by the trusted lens,
    // not revoked, a followable kind) and to follow the chain to its terminal target with cycle
    // detection and a bounded hop cap. {redirectTarget} is the single-redirect read; {followKind}
    // gates which kinds auto-follow; {resolveWithRedirects} is the safe multi-hop walk.

    /// @notice Whether a REDIRECT `kind` is auto-followed at read time (ADR-0050): `sameAs` (0),
    ///         `supersededBy` (1), and `symlink` (2) are followed; everything else — including
    ///         `relatedVersion` (3) and all reserved kinds (≥3) — is a discovery hint that is
    ///         NEVER auto-followed (guards against identity-rerouting "sameAs explosion").
    /// @param  kind The REDIRECT `kind` discriminator.
    /// @return Whether the resolver should follow this kind.
    function followKind(uint16 kind) internal pure returns (bool) {
        return kind == REDIRECT_KIND_SAME_AS || kind == REDIRECT_KIND_SUPERSEDED_BY
            || kind == REDIRECT_KIND_SYMLINK;
    }

    /// @notice Authoritatively read one REDIRECT attestation, lens-scoped: returns its decoded
    ///         `(source, target, kind)` only if the attestation is the REDIRECT schema, was asserted
    ///         by `attester` (the trusted lens), and is not revoked. Otherwise returns all zeros —
    ///         a redirect that does not apply to this lens (or is revoked / wrong schema) is "not a
    ///         redirect" from the lens's point of view, never a revert.
    /// @dev    There is no on-chain source→redirect index (reverse fan-in is off-chain, ADR-0050),
    ///         so the caller supplies `redirectUID` (typically from the off-chain indexer). This is
    ///         the one genuine REDIRECT decode, done once so consumers get the lens-scope and the
    ///         revocation/schema guards right by construction:
    ///           1. `eas.getAttestation(redirectUID)` → the attestation.
    ///           2. Guard `schema == redirectSchema` (an attacker can register any schema pointing
    ///              at a payload that looks like a redirect; only the frozen REDIRECT schema counts).
    ///           3. Guard `attester == attester` (lens-scope — you only follow redirects YOUR lens
    ///              asserts; a foreign attester cannot reroute your identity).
    ///           4. Guard `revocationTime == 0` (REDIRECT is revocable; a retracted redirect is
    ///              inactive — ADR-0051 read-excludes-revoked).
    ///           5. `abi.decode(data, (bytes32, uint16))` → `(target, kind)`; `source` is `refUID`.
    ///         A zero-length / malformed `data` decodes safely to `(0, 0)` (guarded) rather than
    ///         reverting.
    /// @param  eas            The EAS instance the REDIRECT attestation lives in.
    /// @param  redirectSchema The frozen REDIRECT schema UID (from the deployments registry).
    /// @param  redirectUID    The REDIRECT attestation UID to read (caller / off-chain-indexer supplied).
    /// @param  attester       The lens whose redirect to honor.
    /// @return source         The redirect's source (`refUID`), or EMPTY_UID if not an applicable redirect.
    /// @return target         The redirect's destination, or EMPTY_UID if not applicable.
    /// @return kind           The redirect `kind`, or 0 if not applicable.
    function redirectTarget(IEAS eas, bytes32 redirectSchema, bytes32 redirectUID, address attester)
        internal
        view
        returns (bytes32 source, bytes32 target, uint16 kind)
    {
        if (redirectUID == EMPTY_UID) return (EMPTY_UID, EMPTY_UID, 0);
        Attestation memory att = eas.getAttestation(redirectUID);
        // Lens-scope + schema + revocation guards. Any failure ⇒ "not a redirect for this lens".
        if (att.schema != redirectSchema) return (EMPTY_UID, EMPTY_UID, 0);
        if (att.attester != attester) return (EMPTY_UID, EMPTY_UID, 0);
        if (att.revocationTime != 0) return (EMPTY_UID, EMPTY_UID, 0);
        // REDIRECT payload is exactly `(bytes32 target, uint16 kind)` (64 bytes); a malformed/empty
        // body would revert an unguarded decode — treat it as "not a redirect" instead.
        if (att.data.length != 64) return (EMPTY_UID, EMPTY_UID, 0);
        (target, kind) = abi.decode(att.data, (bytes32, uint16));
        source = att.refUID;
    }

    /// @notice Follow a redirect chain from `source` to its terminal target, lens-scoped, with
    ///         cycle detection and a bounded hop cap — the read-time resolution the contracts do
    ///         NOT do (ADR-0050). Returns the terminal UID a consumer should treat as canonical:
    ///         the last `target` reached after following every applicable, followable redirect, or
    ///         `source` unchanged if the first redirect does not apply (no redirect for this lens).
    /// @dev    `redirectUIDs` is the ordered candidate chain the caller (off-chain indexer) believes
    ///         applies, hop by hop — there is no on-chain source→redirect index to discover them
    ///         (reverse fan-in is off-chain, ADR-0050). The walk is authoritative and safe:
    ///           - Each hop is decoded via {redirectTarget} (schema + lens + revocation guards).
    ///           - A hop whose decoded `source` is not the current cursor reverts {RedirectChainBroken}
    ///             (a malformed chain), so a caller cannot smuggle in an unrelated redirect.
    ///           - A non-followable kind (`relatedVersion`/reserved, ADR-0050) STOPS the walk at the
    ///             current cursor — it is not followed and not an error.
    ///           - A hop that does not apply to the lens (revoked / wrong schema / foreign attester /
    ///             absent) STOPS the walk at the current cursor (terminal reached).
    ///           - **Cycle detection:** every visited source is recorded; revisiting one reverts
    ///             {RedirectCycle}. (A single redirect can't self-loop — `AliasResolver` rejects
    ///             `target == refUID` — but A→B / B→A across two lenses can, and is caught here.)
    ///           - **Hop cap:** at most `maxHops` redirects are followed; exceeding it reverts
    ///             {RedirectHopLimit}. `maxHops == 0` ⇒ {REDIRECT_DEFAULT_MAX_HOPS}. The loop is
    ///             bounded by `min(redirectUIDs.length, maxHops)` and the visited-set, so it can
    ///             NEVER loop unbounded.
    ///         NOTE on the cycle rule: ADR-0050's *canonicalization* rule ("resolve to the lowest UID
    ///         in the strongly-connected component") is a global graph computation that needs the
    ///         full edge set — out of scope for an on-chain follower handed a linear candidate chain.
    ///         This follower instead REVERTS on a cycle (fail-closed: never silently teleport to an
    ///         attacker-chosen node), leaving SCC-canonicalization to the off-chain resolver that has
    ///         the whole graph. That is the correct on-chain posture for a bounded, chain-fed walk.
    /// @param  eas            The EAS instance the REDIRECT attestations live in.
    /// @param  redirectSchema The frozen REDIRECT schema UID.
    /// @param  source         The starting UID (a DATA or ANCHOR) to resolve from.
    /// @param  redirectUIDs   The ordered candidate redirect UIDs to follow (off-chain-indexer supplied).
    /// @param  attester       The lens whose redirects to follow.
    /// @param  maxHops        Hop cap (0 ⇒ {REDIRECT_DEFAULT_MAX_HOPS}); follow stops/reverts at it.
    /// @return terminal       The terminal (canonical) UID — `source` if nothing applies.
    /// @return hops           The number of redirects actually followed.
    function resolveWithRedirects(
        IEAS eas,
        bytes32 redirectSchema,
        bytes32 source,
        bytes32[] memory redirectUIDs,
        address attester,
        uint256 maxHops
    ) internal view returns (bytes32 terminal, uint256 hops) {
        uint256 cap = maxHops == 0 ? REDIRECT_DEFAULT_MAX_HOPS : maxHops;
        // Clamp to the hard ceiling so a hostile `maxHops` can't overflow `cap + 1` or force a
        // huge `visited` allocation before any redirect is even inspected.
        if (cap > REDIRECT_MAX_HOPS) cap = REDIRECT_MAX_HOPS;

        // Visited-source set for cycle detection AND the running cursor: `visited[hops]` is always
        // the current terminal, and `hops + 1` entries are populated. Bounded by `cap + 1` entries
        // (the start plus one per followed hop), so memory and the scan are both hop-cap-bounded.
        bytes32[] memory visited = new bytes32[](cap + 1);
        visited[0] = source;

        uint256 n = redirectUIDs.length;
        for (uint256 i = 0; i < n; ++i) {
            (bytes32 src, bytes32 tgt, uint16 kind) =
                redirectTarget(eas, redirectSchema, redirectUIDs[i], attester);

            // Does not apply to this lens (revoked / wrong schema / foreign attester / absent):
            // the chain ends here — the current cursor is terminal.
            if (tgt == EMPTY_UID) break;
            // The supplied redirect must actually start where the walk currently sits.
            if (src != visited[hops]) revert RedirectChainBroken(visited[hops], redirectUIDs[i]);
            // A non-followable kind (relatedVersion / reserved) is a discovery hint, not a hop:
            // stop at the current cursor without following or erroring (ADR-0050).
            if (!followKind(kind)) break;
            // About to follow one more hop — enforce the bounded cap BEFORE advancing.
            if (hops == cap) revert RedirectHopLimit(cap);
            // Cycle check: revisiting any prior source (incl. the original `source`) is a cycle.
            _assertUnvisited(visited, hops + 1, tgt);

            visited[++hops] = tgt;
        }
        terminal = visited[hops];
    }

    /// @dev Revert {RedirectCycle} if `target` already appears in `visited[0..len)`. Extracted from
    ///      {resolveWithRedirects} to keep that function's stack within the optimizer's depth.
    function _assertUnvisited(bytes32[] memory visited, uint256 len, bytes32 target) private pure {
        for (uint256 j = 0; j < len; ++j) {
            if (visited[j] == target) revert RedirectCycle(target);
        }
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
