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
/// @dev    Path-encoding invariant: this lib MUST NOT hash paths. How a path string maps to
///         on-chain identity is a protocol-contracts concern (settled there before schema
///         freeze); the lib passes paths through verbatim so it never diverges from the
///         contracts' canonical encoding.
library EFSLib {
    error NotImplemented();

    /// @notice EAS-native lifecycle fields for a pin (ADR-0003 / B2).
    /// @dev    Mirrors the EAS attestation lifecycle so a pin can carry the same controls
    ///         as the underlying attestation, without overloading the EFS path/UID surface.
    /// @param  expirationTime Unix time after which the pin's attestation is no longer valid
    ///         (0 = no expiry).
    /// @param  revocable      Whether the pin's attestation may later be revoked.
    /// @param  refUID         Optional referenced attestation UID (bytes32(0) = none).
    struct PinOpts {
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
    }

    // --- Reads (lens-scoped) ---
    // read(path) with no lens defaults to the consuming contract's own data
    // (lens = [address(this)]). readAs names an explicit author. Never tx.origin.
    // Returns (exists, dataUID) so a missing file is distinguishable from a present one.

    /// @notice Read the active data UID at `path` for the consuming contract's own lens.
    /// @dev    Returns the *active* pin per lens — revocation and expiry are resolved
    ///         on-chain, so a revoked or expired pin reads as absent (exists = false).
    function read(string memory) internal view returns (bool, bytes32) {
        revert NotImplemented();
    }

    /// @notice Read `path` resolved through an explicit author address.
    /// @dev    Returns the *active* pin per lens — revocation and expiry are resolved
    ///         on-chain, so a revoked or expired pin reads as absent (exists = false).
    function readAs(string memory, address) internal view returns (bool, bytes32) {
        revert NotImplemented();
    }

    /// @notice Read `path` resolved through an explicit, ordered lens stack.
    /// @dev    Returns the *active* pin per lens — revocation and expiry are resolved
    ///         on-chain, so a revoked or expired pin reads as absent (exists = false).
    function read(string memory, address[] memory) internal view returns (bool, bytes32) {
        revert NotImplemented();
    }

    // --- Writes ---

    /// @notice Pin a file: place `dataUID` at `path`. The consuming contract is the attester.
    function pinFile(string memory, bytes32) internal returns (bytes32) {
        revert NotImplemented();
    }

    /// @notice Pin a file at `path` with EAS-native lifecycle controls (`opts`).
    /// @dev    Overload of {pinFile} (B2). Additive — the 2-arg form stays the default; this
    ///         form exposes expiration/revocability/refUID for callers that need them.
    function pinFile(string memory, bytes32, PinOpts memory) internal returns (bytes32) {
        revert NotImplemented();
    }

    /// @notice Create a folder hierarchy for `path` (mkdir -p).
    function mkdir(string memory) internal returns (bytes32) {
        revert NotImplemented();
    }
}
