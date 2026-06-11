// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EFSLib
/// @notice Internal library for reading and writing the Ethereum File System (EFS)
///         from *your own* contract. Functions are `internal` so they inline into
///         the calling contract — preserving `msg.sender` as the EAS attester, which
///         EFS lenses and cardinality-1 PINs depend on (ADR-0003).
/// @dev    Status: scaffold. Signatures are shaped per planning/Designs/sdk-architecture.md
///         (On-chain SDK section); bodies revert until the build lands. Do NOT deploy this
///         as a standalone helper — a separate CALL would make the helper the attester and
///         collapse every consumer into one identity.
library EFSLib {
    error NotImplemented();

    // --- Reads (lens-scoped) ---
    // read(path) with no lens defaults to the consuming contract's own data
    // (lens = [address(this)]). readAs names an explicit author. Never tx.origin.
    // Returns (exists, dataUID) so a missing file is distinguishable from a present one.

    /// @notice Read the active data UID at `path` for the consuming contract's own lens.
    function read(string memory) internal view returns (bool, bytes32) {
        revert NotImplemented();
    }

    /// @notice Read `path` resolved through an explicit author address.
    function readAs(string memory, address) internal view returns (bool, bytes32) {
        revert NotImplemented();
    }

    /// @notice Read `path` resolved through an explicit, ordered lens stack.
    function read(string memory, address[] memory) internal view returns (bool, bytes32) {
        revert NotImplemented();
    }

    // --- Writes ---

    /// @notice Pin a file: place `dataUID` at `path`. The consuming contract is the attester.
    function pinFile(string memory, bytes32) internal returns (bytes32) {
        revert NotImplemented();
    }

    /// @notice Create a folder hierarchy for `path` (mkdir -p).
    function mkdir(string memory) internal returns (bytes32) {
        revert NotImplemented();
    }
}
