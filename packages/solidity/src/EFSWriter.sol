// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EFSLib} from "./EFSLib.sol";

/// @title EFSWriter
/// @notice Inheritable base contract — the happy path for adding EFS *writes* to your contract.
///         Inherit it, hold an {IEAS} reference, and call the wrapped helpers; because {EFSLib}
///         is `internal` and inlines into your contract's context, **your contract stays the EAS
///         attester** (ADR-0003). Run by an EIP-7702 account or an app contract, that is what
///         gives wallet users a one-signature file write (planning/Designs/sdk-minimal-clicks.md).
/// @dev    EFS-level events live here: EAS events are UID-keyed, not domain-keyed, so domain
///         consumers need a path/data-keyed signal. The composition itself lives in {EFSLib}.
abstract contract EFSWriter {
    /// @notice The EAS instance every write attests against. Set once at construction.
    IEAS internal immutable EAS;

    /// @notice Emitted when this contract composes a full file write at a path.
    /// @dev    `fileAnchor` is indexed so domain consumers can filter writes by the path node
    ///         (the file-ANCHOR UID that the placement PIN's `definition` names). `dataUID` is
    ///         indexed so consumers can follow a file's identity across placements.
    /// @param  fileAnchor     The created file-ANCHOR UID (names the path).
    /// @param  dataUID        The DATA (file identity) UID the write placed.
    /// @param  placementPin   The placement-PIN UID that makes the file appear at the path.
    event EFSFileWritten(bytes32 indexed fileAnchor, bytes32 indexed dataUID, bytes32 placementPin);

    /// @param eas The EAS instance this writer attests against.
    constructor(IEAS eas) {
        EAS = eas;
    }

    /// @notice Compose a full file write (DATA + file-ANCHOR + MIRRORs + reserved-key triplets +
    ///         placement PIN) in one transaction; emits {EFSFileWritten}.
    /// @dev    Delegates to {EFSLib.writeFile}, which threads the EAS-returned UIDs in memory. The
    ///         attester of every node is `address(this)` (this contract), because the lib inlines.
    /// @param  w The file-write inputs (schemas, parent anchor, name, mirrors, reserved keys).
    /// @return dataUID         The created DATA UID.
    /// @return fileAnchorUID   The created file-ANCHOR UID.
    /// @return placementPinUID The created placement-PIN UID.
    function _efsWriteFile(EFSLib.FileWrite memory w)
        internal
        returns (bytes32 dataUID, bytes32 fileAnchorUID, bytes32 placementPinUID)
    {
        (dataUID, fileAnchorUID, placementPinUID) = EFSLib.writeFile(EAS, w);
        emit EFSFileWritten(fileAnchorUID, dataUID, placementPinUID);
    }

    /// @notice Hardlink an existing DATA at a new path with a single placement PIN; emits
    ///         {EFSFileWritten}.
    /// @dev    Delegates to {EFSLib.placeExisting} (the dedup short-circuit). Emits the same event
    ///         as a full write so consumers index placements uniformly.
    /// @param  schemas         The frozen schema UID set (only `anchor` and `pin` are used).
    /// @param  dataUID         The pre-existing DATA UID to place.
    /// @param  parentAnchorUID Pre-existing parent folder anchor UID.
    /// @param  fileName        The file's anchor name (verbatim).
    /// @param  forSchema       The file-ANCHOR's `forSchema` field (generic = bytes32(0)).
    /// @return fileAnchorUID   The created file-ANCHOR UID.
    /// @return placementPinUID The created placement-PIN UID.
    function _efsPlaceExisting(
        EFSLib.SchemaUIDs memory schemas,
        bytes32 dataUID,
        bytes32 parentAnchorUID,
        string memory fileName,
        bytes32 forSchema
    ) internal returns (bytes32 fileAnchorUID, bytes32 placementPinUID) {
        (fileAnchorUID, placementPinUID) = EFSLib.placeExisting(
            EAS, schemas, dataUID, parentAnchorUID, fileName, forSchema
        );
        emit EFSFileWritten(fileAnchorUID, dataUID, placementPinUID);
    }
}
