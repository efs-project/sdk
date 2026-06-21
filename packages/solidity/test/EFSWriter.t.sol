// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    MultiAttestationRequest,
    DelegatedAttestationRequest,
    MultiDelegatedAttestationRequest,
    RevocationRequest,
    MultiRevocationRequest,
    DelegatedRevocationRequest,
    MultiDelegatedRevocationRequest
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import {
    ISchemaRegistry
} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {EFSWriter} from "../src/EFSWriter.sol";
import {EFSLib} from "../src/EFSLib.sol";

/// @dev A spy `IEAS` that records every `attest` call (schema + full request data + the
///      msg.sender it saw) and returns a deterministic, unique UID per call. Only `attest` is
///      exercised by EFSLib; the rest revert as unused so a stray call is loud, not silent.
contract MockEAS is IEAS {
    /// @dev One recorded `attest` call, flattened for easy assertions.
    struct Call {
        bytes32 schema;
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
        bytes32 returnedUID;
        address attester; // msg.sender the mock saw — i.e. the inlining caller
    }

    Call[] public calls;

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function callAt(uint256 i) external view returns (Call memory) {
        return calls[i];
    }

    /// @dev Deterministic UID: keccak256("EFS_MOCK_UID", index). Unique & order-revealing.
    function _uidFor(uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("EFS_MOCK_UID", index));
    }

    function attest(AttestationRequest calldata request) external payable returns (bytes32) {
        bytes32 uid = _uidFor(calls.length);
        calls.push(
            Call({
                schema: request.schema,
                recipient: request.data.recipient,
                expirationTime: request.data.expirationTime,
                revocable: request.data.revocable,
                refUID: request.data.refUID,
                data: request.data.data,
                value: request.data.value,
                returnedUID: uid,
                attester: msg.sender
            })
        );
        return uid;
    }

    // ── Unused IEAS surface — revert if ever hit ──────────────────────────────────────────────
    function getSchemaRegistry() external pure returns (ISchemaRegistry) {
        revert("unused");
    }

    function attestByDelegation(DelegatedAttestationRequest calldata)
        external
        payable
        returns (bytes32)
    {
        revert("unused");
    }

    function multiAttest(MultiAttestationRequest[] calldata)
        external
        payable
        returns (bytes32[] memory)
    {
        revert("unused");
    }

    function multiAttestByDelegation(MultiDelegatedAttestationRequest[] calldata)
        external
        payable
        returns (bytes32[] memory)
    {
        revert("unused");
    }

    function revoke(RevocationRequest calldata) external payable {
        revert("unused");
    }

    function revokeByDelegation(DelegatedRevocationRequest calldata) external payable {
        revert("unused");
    }

    function multiRevoke(MultiRevocationRequest[] calldata) external payable {
        revert("unused");
    }

    function multiRevokeByDelegation(MultiDelegatedRevocationRequest[] calldata) external payable {
        revert("unused");
    }

    function timestamp(bytes32) external pure returns (uint64) {
        revert("unused");
    }

    function multiTimestamp(bytes32[] calldata) external pure returns (uint64) {
        revert("unused");
    }

    function revokeOffchain(bytes32) external pure returns (uint64) {
        revert("unused");
    }

    function multiRevokeOffchain(bytes32[] calldata) external pure returns (uint64) {
        revert("unused");
    }

    function getAttestation(bytes32) external pure returns (Attestation memory) {
        revert("unused");
    }

    function isAttestationValid(bytes32) external pure returns (bool) {
        revert("unused");
    }

    function getTimestamp(bytes32) external pure returns (uint64) {
        revert("unused");
    }

    function getRevokeOffchain(address, bytes32) external pure returns (uint64) {
        revert("unused");
    }

    function version() external pure returns (string memory) {
        return "mock";
    }
}

/// @dev A minimal consumer that inherits the writer base, used to assert the inline pattern
///      (the consumer — not the lib — must be the attester EAS records).
contract ConsumerMock is EFSWriter {
    constructor(IEAS eas) EFSWriter(eas) {}

    function writeFile(EFSLib.FileWrite memory w)
        external
        returns (bytes32 dataUID, bytes32 fileAnchorUID, bytes32 placementPinUID)
    {
        return _efsWriteFile(w);
    }

    function placeExisting(
        EFSLib.SchemaUIDs memory schemas,
        bytes32 dataUID,
        bytes32 parentAnchorUID,
        string memory fileName
    ) external returns (bytes32 fileAnchorUID, bytes32 placementPinUID) {
        return _efsPlaceExisting(schemas, dataUID, parentAnchorUID, fileName);
    }

    function placeExistingAt(
        EFSLib.SchemaUIDs memory schemas,
        bytes32 dataUID,
        bytes32 parentAnchorUID,
        string memory fileName,
        bytes32 existingFileAnchorUID
    ) external returns (bytes32 fileAnchorUID, bytes32 placementPinUID) {
        return _efsPlaceExisting(schemas, dataUID, parentAnchorUID, fileName, existingFileAnchorUID);
    }
}

contract EFSWriterTest is Test {
    MockEAS eas;
    ConsumerMock consumer;

    // Distinct, recognizable schema UIDs.
    EFSLib.SchemaUIDs schemas = EFSLib.SchemaUIDs({
        data: keccak256("DATA_SCHEMA"),
        anchor: keccak256("ANCHOR_SCHEMA"),
        property: keccak256("PROPERTY_SCHEMA"),
        mirror: keccak256("MIRROR_SCHEMA"),
        pin: keccak256("PIN_SCHEMA"),
        tag: keccak256("TAG_SCHEMA"),
        list: keccak256("LIST_SCHEMA"),
        listEntry: keccak256("LIST_ENTRY_SCHEMA"),
        redirect: keccak256("REDIRECT_SCHEMA")
    });

    bytes32 constant PARENT = keccak256("PARENT_FOLDER_ANCHOR");
    bytes32 constant TRANSPORT = keccak256("TRANSPORT_IPFS");
    address constant ALICE = address(0xA11CE);

    function setUp() public {
        consumer = new ConsumerMock(IEAS(address(eas = new MockEAS())));
    }

    // Recompute the mock's deterministic UID for the i-th attest call.
    function _uid(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("EFS_MOCK_UID", i));
    }

    function _minimalWrite() internal view returns (EFSLib.FileWrite memory w) {
        w.schemas = schemas;
        w.parentAnchorUID = PARENT;
        w.fileName = "hello.txt";
        // empty mirrors + reservedKeys
    }

    /// @notice Minimal file: DATA + file-ANCHOR + placement-PIN, in that order, correctly threaded.
    function test_MinimalWrite_OrderAndThreading() public {
        EFSLib.FileWrite memory w = _minimalWrite();

        vm.prank(ALICE);
        (bytes32 dataUID, bytes32 fileAnchorUID, bytes32 pinUID) = consumer.writeFile(w);

        assertEq(eas.callCount(), 3, "minimal write = 3 attestations");

        // Call 0: DATA
        MockEAS.Call memory c0 = eas.callAt(0);
        assertEq(c0.schema, schemas.data, "c0 schema = DATA");
        assertEq(c0.refUID, bytes32(0), "DATA refUID = 0");
        assertEq(c0.revocable, false, "DATA non-revocable");
        assertEq(c0.expirationTime, 0, "DATA no expiration");
        assertEq(c0.data.length, 0, "DATA empty data");
        assertEq(c0.recipient, address(0), "DATA recipient 0");
        assertEq(c0.value, 0, "DATA value 0");
        assertEq(dataUID, _uid(0), "returned dataUID = call-0 UID");

        // Call 1: file-ANCHOR
        MockEAS.Call memory c1 = eas.callAt(1);
        assertEq(c1.schema, schemas.anchor, "c1 schema = ANCHOR");
        assertEq(c1.refUID, PARENT, "file-ANCHOR refUID = parent");
        assertEq(c1.revocable, false, "ANCHOR non-revocable");
        assertEq(
            c1.data, abi.encode("hello.txt", schemas.data), "file-ANCHOR data = (name, DATA schema)"
        );
        assertEq(fileAnchorUID, _uid(1), "returned fileAnchorUID = call-1 UID");

        // Call 2: placement-PIN — definition = file-ANCHOR (threaded), refUID = DATA (threaded)
        MockEAS.Call memory c2 = eas.callAt(2);
        assertEq(c2.schema, schemas.pin, "c2 schema = PIN");
        assertEq(c2.refUID, dataUID, "placement-PIN refUID = DATA UID");
        assertEq(c2.revocable, true, "PIN revocable");
        assertEq(c2.expirationTime, 0, "PIN no expiration");
        assertEq(c2.data, abi.encode(fileAnchorUID), "PIN data = (file-ANCHOR UID)");
        assertEq(pinUID, _uid(2), "returned placementPinUID = call-2 UID");

        // Attester = the consumer contract (lib inlined; msg.sender preserved through to EAS).
        assertEq(c0.attester, address(consumer), "DATA attester = consumer (inlined)");
        assertEq(c2.attester, address(consumer), "PIN attester = consumer (inlined)");
    }

    /// @notice Overwrite: `existingFileAnchorUID` set ⇒ NO file-ANCHOR mint; the placement PIN
    ///         supersedes the prior one at the reused (permanent) anchor.
    function test_WriteFile_ReusesExistingFileAnchor() public {
        EFSLib.FileWrite memory w = _minimalWrite();
        bytes32 existing = keccak256("existing_file_anchor");
        w.existingFileAnchorUID = existing;

        vm.prank(ALICE);
        (bytes32 dataUID, bytes32 fileAnchorUID, bytes32 pinUID) = consumer.writeFile(w);

        // DATA + placement PIN only — the permanent file-ANCHOR is reused, not re-minted.
        assertEq(eas.callCount(), 2, "overwrite = DATA + placement PIN (no anchor mint)");
        assertEq(fileAnchorUID, existing, "returns the reused anchor");

        MockEAS.Call memory pin = eas.callAt(1);
        assertEq(pin.schema, schemas.pin, "call 1 = placement PIN");
        assertEq(pin.data, abi.encode(existing), "PIN definition = the reused anchor");
        assertEq(pin.refUID, dataUID, "PIN refUID = the fresh DATA");
        assertEq(pinUID, _uid(1), "returned placement-PIN UID");
    }

    /// @notice Full graph: DATA, file-ANCHOR, 1 MIRROR, 2 reserved-key triplets, placement-PIN.
    function test_FullWrite_OrderThreadingAndConstraints() public {
        EFSLib.FileWrite memory w = _minimalWrite();

        w.mirrors = new EFSLib.Mirror[](1);
        w.mirrors[0] = EFSLib.Mirror({transportDefinition: TRANSPORT, uri: "ipfs://Qm123"});

        w.reservedKeys = new EFSLib.ReservedKey[](2);
        w.reservedKeys[0] = EFSLib.ReservedKey({key: "contentHash", value: "0xdeadbeef"});
        w.reservedKeys[1] = EFSLib.ReservedKey({key: "size", value: "1024"});

        (bytes32 dataUID, bytes32 fileAnchorUID, bytes32 pinUID) = consumer.writeFile(w);

        // 1 DATA + 1 file-ANCHOR + 1 MIRROR + 2*(keyAnchor + property + bindingPin) + 1 placement
        // = 1 + 1 + 1 + 6 + 1 = 10
        assertEq(eas.callCount(), 10, "full write = 10 attestations");

        // 0: DATA, 1: file-ANCHOR (already covered above; spot-check identity wiring)
        assertEq(dataUID, _uid(0));
        assertEq(fileAnchorUID, _uid(1));

        // 2: MIRROR — refUID = DATA, revocable, data = (transportDefinition, uri)
        MockEAS.Call memory mir = eas.callAt(2);
        assertEq(mir.schema, schemas.mirror, "MIRROR schema");
        assertEq(mir.refUID, dataUID, "MIRROR refUID = DATA");
        assertEq(mir.revocable, true, "MIRROR revocable");
        assertEq(mir.expirationTime, 0, "MIRROR no expiration");
        assertEq(mir.data, abi.encode(TRANSPORT, "ipfs://Qm123"), "MIRROR data");

        // Reserved key #0 (contentHash): calls 3 (key-ANCHOR), 4 (PROPERTY), 5 (binding-PIN)
        _assertReservedTriplet(3, dataUID, "contentHash", "0xdeadbeef");
        // Reserved key #1 (size): calls 6, 7, 8
        _assertReservedTriplet(6, dataUID, "size", "1024");

        // 9: placement-PIN — definition = file-ANCHOR, refUID = DATA
        MockEAS.Call memory pin = eas.callAt(9);
        assertEq(pin.schema, schemas.pin, "placement-PIN schema");
        assertEq(pin.refUID, dataUID, "placement-PIN refUID = DATA");
        assertEq(pin.revocable, true, "placement-PIN revocable");
        assertEq(pin.data, abi.encode(fileAnchorUID), "placement-PIN definition = file-ANCHOR");
        assertEq(pinUID, _uid(9), "returned placementPinUID = call-9 UID");
    }

    /// @dev Assert one reserved-key triplet starting at call index `base`:
    ///      base   = key-ANCHOR (refUID = DATA, non-revocable, data = (key, PROPERTY forSchema))
    ///      base+1 = PROPERTY   (refUID = 0,    non-revocable, data = (value))
    ///      base+2 = binding-PIN(refUID = PROPERTY, revocable, definition = key-ANCHOR)
    function _assertReservedTriplet(
        uint256 base,
        bytes32 dataUID,
        string memory key,
        string memory value
    ) internal view {
        MockEAS.Call memory keyAnchor = eas.callAt(base);
        assertEq(keyAnchor.schema, schemas.anchor, "key-ANCHOR schema");
        assertEq(keyAnchor.refUID, dataUID, "key-ANCHOR refUID = DATA");
        assertEq(keyAnchor.revocable, false, "key-ANCHOR non-revocable");
        assertEq(
            keyAnchor.data, abi.encode(key, schemas.property), "key-ANCHOR data = (key, PROPERTY)"
        );

        MockEAS.Call memory property = eas.callAt(base + 1);
        assertEq(property.schema, schemas.property, "PROPERTY schema");
        assertEq(property.refUID, bytes32(0), "PROPERTY refUID = 0");
        assertEq(property.revocable, false, "PROPERTY non-revocable");
        assertEq(property.data, abi.encode(value), "PROPERTY data = (value)");

        MockEAS.Call memory bindingPin = eas.callAt(base + 2);
        assertEq(bindingPin.schema, schemas.pin, "binding-PIN schema");
        assertEq(
            bindingPin.refUID, property.returnedUID, "binding-PIN refUID = PROPERTY (threaded)"
        );
        assertEq(bindingPin.revocable, true, "binding-PIN revocable");
        assertEq(
            bindingPin.data,
            abi.encode(keyAnchor.returnedUID),
            "binding-PIN definition = key-ANCHOR (threaded)"
        );
    }

    /// @notice Hardlink path: file-ANCHOR + single placement PIN pointing at a PRE-EXISTING DATA.
    function test_PlaceExisting_SinglePinHardlink() public {
        bytes32 existingData = keccak256("PRE_EXISTING_DATA");

        vm.prank(ALICE);
        (bytes32 fileAnchorUID, bytes32 pinUID) =
            consumer.placeExisting(schemas, existingData, PARENT, "linked.txt");

        assertEq(eas.callCount(), 2, "hardlink = 2 attestations (anchor + pin)");

        // 0: file-ANCHOR
        MockEAS.Call memory anchor = eas.callAt(0);
        assertEq(anchor.schema, schemas.anchor, "hardlink anchor schema");
        assertEq(anchor.refUID, PARENT, "hardlink anchor refUID = parent");
        assertEq(anchor.revocable, false, "hardlink anchor non-revocable");
        assertEq(
            anchor.data, abi.encode("linked.txt", schemas.data), "hardlink anchor data (DATA-typed)"
        );
        assertEq(fileAnchorUID, _uid(0));

        // 1: placement-PIN pointing at the PRE-EXISTING DATA (no fresh DATA minted)
        MockEAS.Call memory pin = eas.callAt(1);
        assertEq(pin.schema, schemas.pin, "hardlink pin schema");
        assertEq(pin.refUID, existingData, "hardlink pin refUID = pre-existing DATA");
        assertEq(pin.revocable, true, "hardlink pin revocable");
        assertEq(pin.data, abi.encode(fileAnchorUID), "hardlink pin definition = file-ANCHOR");
        assertEq(pinUID, _uid(1));

        // No DATA schema attestation anywhere in the hardlink path.
        assertTrue(
            anchor.schema != schemas.data && pin.schema != schemas.data, "no fresh DATA minted"
        );
    }

    /// @notice Overwrite/relink: re-pointing an EXISTING path reuses its permanent file-ANCHOR
    ///         (no re-mint) and emits only the cardinality-1 placement PIN — re-minting the
    ///         `(parent, name, DATA)` anchor would revert (DuplicateFileName) or file a
    ///         non-canonical anchor the read path never finds. Mirrors the TS hardlink branch.
    function test_PlaceExistingAt_ReusesAnchorOnRelink() public {
        bytes32 existingData = keccak256("PRE_EXISTING_DATA_2");
        bytes32 existingAnchor = keccak256("ALREADY_RESOLVED_FILE_ANCHOR");

        vm.prank(ALICE);
        (bytes32 fileAnchorUID, bytes32 pinUID) =
            consumer.placeExistingAt(schemas, existingData, PARENT, "linked.txt", existingAnchor);

        assertEq(eas.callCount(), 1, "relink = ONE attestation (the placement PIN only)");

        // The single attestation is the placement PIN, bound to the EXISTING anchor.
        MockEAS.Call memory pin = eas.callAt(0);
        assertEq(pin.schema, schemas.pin, "relink pin schema");
        assertEq(pin.refUID, existingData, "relink pin refUID = pre-existing DATA");
        assertEq(
            pin.data, abi.encode(existingAnchor), "relink pin definition = existing file-ANCHOR"
        );
        assertEq(fileAnchorUID, existingAnchor, "returns the reused anchor (no fresh mint)");
        assertEq(pinUID, _uid(0));

        // No ANCHOR-schema attestation: the permanent file-ANCHOR was NOT re-minted.
        assertTrue(pin.schema != schemas.anchor, "no fresh file-ANCHOR minted on relink");
    }

    /// @notice The 6-arg form with a zero `existingFileAnchorUID` behaves like the 4-arg form:
    ///         it MINTS a fresh file-ANCHOR (place at a NEW path).
    function test_PlaceExistingAt_ZeroAnchorMintsLikeNewPath() public {
        bytes32 existingData = keccak256("PRE_EXISTING_DATA_3");
        vm.prank(ALICE);
        consumer.placeExistingAt(schemas, existingData, PARENT, "fresh.txt", bytes32(0));
        assertEq(eas.callCount(), 2, "new path = anchor + pin (2 attestations)");
        assertEq(eas.callAt(0).schema, schemas.anchor, "minted a fresh file-ANCHOR");
    }

    /// @notice The library inlines, so EAS records the CALLER (the consumer) as attester, never
    ///         the library — the ADR-0003 identity-preservation invariant.
    function test_AttesterIsConsumerNotLibrary() public {
        EFSLib.FileWrite memory w = _minimalWrite();
        vm.prank(ALICE);
        consumer.writeFile(w);
        uint256 n = eas.callCount();
        for (uint256 i = 0; i < n; ++i) {
            assertEq(eas.callAt(i).attester, address(consumer), "every attester = consumer");
        }
    }
}
