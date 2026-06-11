// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EFSLib} from "./EFSLib.sol";

/// @title EFSWriter
/// @notice Inheritable base contract — the happy path for adding EFS to your contract.
///         Inherit it and call the wrapped helpers; because the base runs in your
///         contract's context, your contract stays the EAS attester (ADR-0003).
/// @dev    Status: scaffold. Methods delegate to {EFSLib}, whose bodies revert until the
///         build lands. EFS-level events/errors live here (EAS events are UID-keyed, not
///         domain-keyed, so domain consumers need these).
abstract contract EFSWriter {
    /// @notice Emitted when this contract pins a file at a path.
    /// @dev    `path` is indexed so domain consumers can filter pins by path hash
    ///         (indexed strings are stored as their keccak256 hash in the topic).
    event EFSFilePinned(string indexed path, bytes32 indexed dataUID, bytes32 pinUID);

    // --- Reads (view) ---

    /// @notice Read this contract's own file at `path`.
    function _efsRead(string memory path) internal view returns (bool exists, bytes32 dataUID) {
        return EFSLib.read(path);
    }

    /// @notice Read `path` resolved through an explicit author address.
    function _efsReadAs(string memory path, address author)
        internal
        view
        returns (bool exists, bytes32 dataUID)
    {
        return EFSLib.readAs(path, author);
    }

    /// @notice Read `path` resolved through an explicit, ordered lens stack.
    function _efsRead(string memory path, address[] memory lens)
        internal
        view
        returns (bool exists, bytes32 dataUID)
    {
        return EFSLib.read(path, lens);
    }

    // --- Writes ---

    /// @notice Pin a file at `path`; emits {EFSFilePinned} for domain consumers.
    /// @dev    {EFSLib.pinFile} reverts until implemented, so the emit is unreachable
    ///         for now — but this locks the happy-path shape (capture, emit, return)
    ///         so inheritors get the event without writing their own wrapper.
    function _efsPinFile(string memory path, bytes32 dataUID) internal returns (bytes32 pinUID) {
        pinUID = EFSLib.pinFile(path, dataUID);
        emit EFSFilePinned(path, dataUID, pinUID);
    }

    /// @notice Pin a file at `path` with EAS-native lifecycle controls (`opts`); emits {EFSFilePinned}.
    /// @dev    Overload mirroring {EFSLib.pinFile} with {EFSLib.PinOpts} (B2). Emits the same
    ///         event as the 2-arg form so consumers index pins uniformly regardless of opts.
    function _efsPinFile(string memory path, bytes32 dataUID, EFSLib.PinOpts memory opts)
        internal
        returns (bytes32 pinUID)
    {
        pinUID = EFSLib.pinFile(path, dataUID, opts);
        emit EFSFilePinned(path, dataUID, pinUID);
    }

    /// @notice Create a folder hierarchy for `path` (mkdir -p).
    /// @dev    No event yet: mkdir has no EFS-level event in the design, so this wrapper
    ///         intentionally does not emit. Add one here if/when the design defines it.
    function _efsMkdir(string memory path) internal returns (bytes32 dirUID) {
        return EFSLib.mkdir(path);
    }
}
