// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title EFSLib
/// @notice Internal library for reading and writing the Ethereum File System (EFS)
///         from *your own* contract. Functions are `internal` so they inline into
///         the calling contract — preserving `msg.sender` as the EAS attester, which
///         EFS lenses and cardinality-1 PINs depend on (ADR-0003).
/// @dev    Status: scaffold. Signatures are shaped per planning/Designs/sdk-architecture.md
///         (On-chain SDK section); bodies are stubs until the build lands. Do NOT deploy
///         this as a standalone helper — a separate CALL would make the helper the
///         attester and collapse every consumer into one identity.
library EFSLib {
    error NotImplemented();

    // ── Reads (lens-scoped) ────────────────────────────────────────────────────
    // read(path) with no lens defaults to the consuming contract's own data
    // (lens = [address(this)]). readAs names an explicit author. Never tx.origin.

    /// @notice Read the data UID at `path` for the consuming contract's own lens.
    /// @return exists Whether a file is present (your namespace is usually empty).
    /// @return dataUID The active DATA attestation UID at the path.
    function read(string memory /*path*/ )
        internal
        view
        returns (bool exists, bytes32 dataUID)
    {
        // lens = [address(this)]
        exists; // silence
        revert NotImplemented();
    }

    /// @notice Read `path` resolved through an explicit author address.
    function readAs(string memory, /*path*/ address /*who*/ )
        internal
        view
        returns (bool exists, bytes32 dataUID)
    {
        revert NotImplemented();
    }

    /// @notice Read `path` resolved through an explicit, ordered lens stack.
    function read(string memory, /*path*/ address[] memory /*lenses*/ )
        internal
        view
        returns (bool exists, bytes32 dataUID)
    {
        revert NotImplemented();
    }

    // ── Writes ─────────────────────────────────────────────────────────────────

    /// @notice Pin a file: place `dataUID` at `path`. The consuming contract is the attester.
    function pinFile(string memory, /*path*/ bytes32 /*dataUID*/ ) internal returns (bytes32 pinUID) {
        revert NotImplemented();
    }

    /// @notice Create a folder hierarchy for `path` (mkdir -p).
    function mkdir(string memory /*path*/ ) internal returns (bytes32 anchorUID) {
        revert NotImplemented();
    }
}
