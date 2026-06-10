// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EFSLib} from "./EFSLib.sol";

/// @title EFSWriter
/// @notice Inheritable base contract — the happy path for adding EFS to your contract.
///         Inherit it and call the wrapped helpers; because the base runs in your
///         contract's context, your contract stays the EAS attester (ADR-0003).
/// @dev    Status: scaffold. Methods delegate to {EFSLib}; bodies are stubs until the
///         build lands. EFS-level events/errors live here (EAS events are UID-keyed,
///         not domain-keyed, so domain consumers need these).
abstract contract EFSWriter {
    using EFSLib for *;

    /// @notice Emitted when this contract pins a file at a path.
    event EfsFilePinned(string path, bytes32 indexed dataUID, bytes32 pinUID);

    /// @notice Read this contract's own file at `path`.
    function _efsRead(string memory path) internal view returns (bool exists, bytes32 dataUID) {
        return EFSLib.read(path);
    }

    /// @notice Pin a file at `path`; emits {EfsFilePinned}.
    function _efsPinFile(string memory path, bytes32 dataUID) internal returns (bytes32 pinUID) {
        pinUID = EFSLib.pinFile(path, dataUID);
        emit EfsFilePinned(path, dataUID, pinUID);
    }
}
