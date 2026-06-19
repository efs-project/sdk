// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

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
    /// @dev `recipient` is always the zero address for EFS write attestations.
    address internal constant ZERO_RECIPIENT = address(0);
    /// @dev `expirationTime` is always 0 — EFS reads filter on revocation/index state, never on
    ///      EAS expiry, and several resolvers reject a nonzero `expirationTime` outright.
    uint64 internal constant NO_EXPIRATION = 0;
    /// @dev `value` is always 0 — no EFS write schema has a payable resolver.
    uint256 internal constant NO_VALUE = 0;

    /// @notice The frozen EFS schema UIDs needed to compose a file write. Pass the set for the
    ///         target deployment (the SDK's per-chain deployments registry resolves these).
    /// @dev    DATA is the empty schema; ANCHOR is `string name, bytes32 forSchema`; PROPERTY is
    ///         `string value`; MIRROR is `bytes32 transportDefinition, string uri`; PIN is
    ///         `bytes32 definition`. The TAG schema is NOT needed here — ancestor-visibility TAGs
    ///         are a resolve-step concern layered by the off-chain submitter, not part of the pure
    ///         single-file graph (graph.ts module doc; spec L3 `×M`).
    struct SchemaUIDs {
        bytes32 data;
        bytes32 anchor;
        bytes32 property;
        bytes32 mirror;
        bytes32 pin;
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
    ///         decimal byte length for `size`, the `0x…` hex digest for `contentHash`).
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
    /// @param  forSchema           The file-ANCHOR's `forSchema` content-type field. Generic
    ///         (`bytes32(0)`) for a plain file, matching graph.ts's `GENERIC_FOR_SCHEMA`.
    /// @param  mirrors             Retrieval methods to publish (one MIRROR each). May be empty.
    /// @param  reservedKeys        Reserved-key triplets to bind (contentType/contentHash/size).
    ///         May be empty (e.g. a minimal file with no metadata).
    struct FileWrite {
        SchemaUIDs schemas;
        bytes32 parentAnchorUID;
        string fileName;
        bytes32 forSchema;
        Mirror[] mirrors;
        ReservedKey[] reservedKeys;
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
        // resolved from refUID (:396). data = abi.encode(name, forSchema).
        fileAnchorUID =
            _attestAnchor(eas, w.schemas.anchor, w.fileName, w.forSchema, w.parentAnchorUID);

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
            // the file identity). forSchema is generic (PROPERTY binding targets via the PIN's
            // definition/refUID, not via this field) — matches graph.ts GENERIC_FOR_SCHEMA.
            bytes32 keyAnchorUID = _attestAnchor(eas, w.schemas.anchor, rk.key, EMPTY_UID, dataUID);

            // L2 PROPERTY: the interned value. PROPERTY onAttest rejects refUID≠0
            // (EFSIndexer.sol:488) and revocable (EFSIndexer.sol:489). data = abi.encode(value).
            bytes32 propertyUID = eas.attest(
                AttestationRequest({
                    schema: w.schemas.property,
                    data: AttestationRequestData({
                        recipient: ZERO_RECIPIENT,
                        expirationTime: NO_EXPIRATION,
                        revocable: false, // EFSIndexer.sol:489 — rejects revocable
                        refUID: EMPTY_UID, // EFSIndexer.sol:488 — refUID must be EMPTY_UID
                        data: abi.encode(rk.value),
                        value: NO_VALUE
                    })
                })
            );

            // L3 binding-PIN: definition = key-ANCHOR (fresh), refUID = PROPERTY (fresh) — the
            // deepest edge, referencing two fresh L2 siblings. EdgeResolver PIN requires
            // revocable=true and expirationTime 0. data = abi.encode(definition).
            _attestPin(eas, w.schemas.pin, keyAnchorUID, propertyUID);
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
    /// @param  schemas         The frozen schema UID set (only `anchor` and `pin` are used).
    /// @param  dataUID         The pre-existing DATA UID to place.
    /// @param  parentAnchorUID Pre-existing parent folder anchor UID (the file-ANCHOR's refUID).
    /// @param  fileName        The file's anchor name (verbatim).
    /// @param  forSchema       The file-ANCHOR's `forSchema` field (generic = bytes32(0)).
    /// @return fileAnchorUID   The created file-ANCHOR UID.
    /// @return placementPinUID The created placement-PIN UID.
    function placeExisting(
        IEAS eas,
        SchemaUIDs memory schemas,
        bytes32 dataUID,
        bytes32 parentAnchorUID,
        string memory fileName,
        bytes32 forSchema
    ) internal returns (bytes32 fileAnchorUID, bytes32 placementPinUID) {
        fileAnchorUID = _attestAnchor(eas, schemas.anchor, fileName, forSchema, parentAnchorUID);
        placementPinUID = _attestPin(eas, schemas.pin, fileAnchorUID, dataUID);
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
}
