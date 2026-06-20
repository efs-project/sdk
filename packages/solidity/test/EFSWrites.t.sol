// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EFSWriter} from "../src/EFSWriter.sol";
import {EFSLib} from "../src/EFSLib.sol";
import {MockEAS} from "./EFSWriter.t.sol";

/// @dev Consumer exposing the new primitive wrappers, to assert the inline (attester = consumer)
///      pattern holds for tag/property/place/list writes exactly as it does for {writeFile}.
contract WritesConsumerMock is EFSWriter {
    constructor(IEAS eas) EFSWriter(eas) {}

    function anchorAt(EFSLib.SchemaUIDs memory s, bytes32 parent, string memory name)
        external
        returns (bytes32)
    {
        return _efsAnchorAt(s, parent, name);
    }

    function tag(EFSLib.SchemaUIDs memory s, bytes32 target, bytes32 def, int256 weight)
        external
        returns (bytes32)
    {
        return _efsTag(s, target, def, weight);
    }

    function setProperty(EFSLib.SchemaUIDs memory s, bytes32 data, string memory k, string memory v)
        external
        returns (bytes32, bytes32, bytes32)
    {
        return _efsSetProperty(s, data, k, v);
    }

    function place(EFSLib.SchemaUIDs memory s, bytes32 anchor, bytes32 data)
        external
        returns (bytes32)
    {
        return _efsPlace(s, anchor, data);
    }

    function createList(
        EFSLib.SchemaUIDs memory s,
        bool dups,
        bool appendOnly,
        uint8 targetType,
        bytes32 targetSchema,
        uint256 maxEntries
    ) external returns (bytes32) {
        return _efsCreateList(s, dups, appendOnly, targetType, targetSchema, maxEntries);
    }

    function addEntry(EFSLib.SchemaUIDs memory s, bytes32 listUID, bytes32 target)
        external
        returns (bytes32)
    {
        return _efsAddEntry(s, listUID, target);
    }

    function addAddressEntry(EFSLib.SchemaUIDs memory s, bytes32 listUID, address member)
        external
        returns (bytes32)
    {
        return EFSLib.addAddressEntry(EAS, s, listUID, member);
    }
}

contract EFSWritesTest is Test {
    MockEAS eas;
    WritesConsumerMock consumer;

    EFSLib.SchemaUIDs schemas = EFSLib.SchemaUIDs({
        data: keccak256("DATA_SCHEMA"),
        anchor: keccak256("ANCHOR_SCHEMA"),
        property: keccak256("PROPERTY_SCHEMA"),
        mirror: keccak256("MIRROR_SCHEMA"),
        pin: keccak256("PIN_SCHEMA"),
        tag: keccak256("TAG_SCHEMA"),
        list: keccak256("LIST_SCHEMA"),
        listEntry: keccak256("LIST_ENTRY_SCHEMA")
    });

    bytes32 constant PARENT = keccak256("PARENT_FOLDER_ANCHOR");
    bytes32 constant DATA_UID = keccak256("SOME_DATA");
    bytes32 constant TARGET = keccak256("TAG_TARGET");
    address constant ALICE = address(0xA11CE);

    function setUp() public {
        consumer = new WritesConsumerMock(IEAS(address(eas = new MockEAS())));
    }

    function _uid(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("EFS_MOCK_UID", i));
    }

    // ── anchorAt (mkdir) ─────────────────────────────────────────────────────────────────────

    function test_AnchorAt_MkdirEmitsAnchor() public {
        vm.prank(ALICE);
        bytes32 anchorUID = consumer.anchorAt(schemas, PARENT, "docs");

        assertEq(eas.callCount(), 1, "mkdir = 1 attestation");
        MockEAS.Call memory c = eas.callAt(0);
        assertEq(c.schema, schemas.anchor, "schema = ANCHOR");
        assertEq(c.refUID, PARENT, "refUID = parent");
        assertEq(c.revocable, false, "ANCHOR non-revocable");
        assertEq(c.expirationTime, 0, "no expiration");
        assertEq(c.recipient, address(0), "recipient 0");
        assertEq(c.data, abi.encode("docs", bytes32(0)), "data = (name, generic forSchema)");
        assertEq(anchorUID, _uid(0), "returns the minted anchor UID");
        assertEq(c.attester, address(consumer), "attester = consumer (inlined)");
    }

    // ── tag (cardinality-N edge, carries weight) ─────────────────────────────────────────────

    function test_Tag_CarriesDefinitionAndWeight() public {
        bytes32 def = keccak256("FOLDER_VISIBILITY_DEF");
        vm.prank(ALICE);
        bytes32 tagUID = consumer.tag(schemas, TARGET, def, int256(-7));

        assertEq(eas.callCount(), 1, "tag = 1 attestation");
        MockEAS.Call memory c = eas.callAt(0);
        assertEq(c.schema, schemas.tag, "schema = TAG");
        assertEq(c.refUID, TARGET, "edge target via refUID");
        assertEq(c.revocable, true, "TAG revocable");
        assertEq(c.expirationTime, 0, "no expiration");
        assertEq(c.recipient, address(0), "recipient 0");
        // (definition, weight) - 64 bytes exact; weight is signed.
        assertEq(c.data, abi.encode(def, int256(-7)), "data = (definition, weight)");
        assertEq(c.data.length, 64, "TAG payload is canonical 64 bytes");
        assertEq(tagUID, _uid(0));
        assertEq(c.attester, address(consumer), "attester = consumer");
    }

    function test_Tag_DecodesBackToInputs() public {
        bytes32 def = keccak256("LABEL");
        vm.prank(ALICE);
        consumer.tag(schemas, TARGET, def, int256(42));
        (bytes32 gotDef, int256 gotWeight) = abi.decode(eas.callAt(0).data, (bytes32, int256));
        assertEq(gotDef, def, "definition round-trips");
        assertEq(gotWeight, int256(42), "weight round-trips");
    }

    // ── setProperty (the key/value triple) ───────────────────────────────────────────────────

    function test_SetProperty_ThreadsTripleCorrectly() public {
        vm.prank(ALICE);
        (bytes32 keyAnchorUID, bytes32 propertyUID, bytes32 bindingPinUID) =
            consumer.setProperty(schemas, DATA_UID, "author", "alice");

        assertEq(eas.callCount(), 3, "property triple = 3 attestations");

        // 0: key-ANCHOR (name = key, refUID = DATA, forSchema = PROPERTY schema, non-revocable)
        MockEAS.Call memory ka = eas.callAt(0);
        assertEq(ka.schema, schemas.anchor, "key-ANCHOR schema");
        assertEq(ka.refUID, DATA_UID, "key-ANCHOR refUID = DATA");
        assertEq(ka.revocable, false, "key-ANCHOR non-revocable");
        assertEq(
            ka.data, abi.encode("author", schemas.property), "key-ANCHOR data = (key, PROPERTY)"
        );
        assertEq(keyAnchorUID, _uid(0));

        // 1: PROPERTY (free-floating value)
        MockEAS.Call memory p = eas.callAt(1);
        assertEq(p.schema, schemas.property, "PROPERTY schema");
        assertEq(p.refUID, bytes32(0), "PROPERTY refUID = 0 (free-floating)");
        assertEq(p.revocable, false, "PROPERTY non-revocable");
        assertEq(p.data, abi.encode("alice"), "PROPERTY data = (value)");
        assertEq(propertyUID, _uid(1));

        // 2: binding-PIN (definition = key-ANCHOR threaded, refUID = PROPERTY threaded)
        MockEAS.Call memory bp = eas.callAt(2);
        assertEq(bp.schema, schemas.pin, "binding-PIN schema");
        assertEq(bp.refUID, propertyUID, "binding-PIN refUID = PROPERTY (threaded)");
        assertEq(bp.revocable, true, "binding-PIN revocable");
        assertEq(
            bp.data, abi.encode(keyAnchorUID), "binding-PIN definition = key-ANCHOR (threaded)"
        );
        assertEq(bindingPinUID, _uid(2));

        assertEq(ka.attester, address(consumer), "attester = consumer across the triple");
        assertEq(bp.attester, address(consumer));
    }

    // ── place (cardinality-1 placement PIN) ──────────────────────────────────────────────────

    function test_Place_BindsDataAtAnchor() public {
        bytes32 anchor = keccak256("FILE_ANCHOR");
        vm.prank(ALICE);
        bytes32 pinUID = consumer.place(schemas, anchor, DATA_UID);

        assertEq(eas.callCount(), 1, "place = 1 attestation");
        MockEAS.Call memory c = eas.callAt(0);
        assertEq(c.schema, schemas.pin, "schema = PIN");
        assertEq(c.refUID, DATA_UID, "PIN refUID = DATA (edge target)");
        assertEq(c.revocable, true, "PIN revocable");
        assertEq(c.expirationTime, 0, "no expiration");
        assertEq(c.data, abi.encode(anchor), "PIN definition = anchor");
        assertEq(pinUID, _uid(0));
        assertEq(c.attester, address(consumer), "attester = consumer");
    }

    // ── createList + addEntry ────────────────────────────────────────────────────────────────

    function test_CreateList_EncodesModeFields() public {
        bytes32 targetSchema = keccak256("ENTRY_TARGET_SCHEMA");
        vm.prank(ALICE);
        // SCHEMA mode (2): targetSchema nonzero.
        bytes32 listUID = consumer.createList(schemas, false, true, 2, targetSchema, 100);

        assertEq(eas.callCount(), 1, "createList = 1 attestation");
        MockEAS.Call memory c = eas.callAt(0);
        assertEq(c.schema, schemas.list, "schema = LIST");
        assertEq(c.refUID, bytes32(0), "LIST free-floating (refUID 0)");
        assertEq(c.recipient, address(0), "LIST undirected (recipient 0)");
        assertEq(c.revocable, false, "LIST non-revocable");
        assertEq(c.expirationTime, 0, "LIST no expiration");
        assertEq(
            c.data,
            abi.encode(false, true, uint8(2), targetSchema, uint256(100)),
            "LIST data = (dups, appendOnly, targetType, targetSchema, maxEntries)"
        );
        assertEq(c.data.length, 160, "LIST payload is canonical 160 bytes");
        assertEq(listUID, _uid(0));
        assertEq(c.attester, address(consumer), "curator = consumer (attester)");
    }

    function test_AddEntry_ReferencesItsListByPayloadNotRefUID() public {
        vm.startPrank(ALICE);
        bytes32 listUID = consumer.createList(schemas, true, false, 0, bytes32(0), 0); // ANY mode
        bytes32 memberKey = keccak256("MEMBER_1");
        bytes32 entryUID = consumer.addEntry(schemas, listUID, memberKey);
        vm.stopPrank();

        assertEq(eas.callCount(), 2, "list + entry = 2 attestations");
        MockEAS.Call memory e = eas.callAt(1);
        assertEq(e.schema, schemas.listEntry, "schema = LIST_ENTRY");
        // The LIST is referenced via the listUID PAYLOAD field, NOT via refUID (which must be 0).
        assertEq(e.refUID, bytes32(0), "LIST_ENTRY refUID MUST be 0 (UsesRefUID)");
        assertEq(e.recipient, address(0), "ANY mode - recipient 0");
        assertEq(e.revocable, true, "LIST_ENTRY revocable");
        assertEq(e.expirationTime, 0, "no expiration");
        assertEq(e.data, abi.encode(listUID, memberKey), "data = (listUID, target)");
        assertEq(e.data.length, 64, "LIST_ENTRY payload is canonical 64 bytes");

        // Decode confirms the entry points back at its list.
        (bytes32 gotListUID, bytes32 gotTarget) = abi.decode(e.data, (bytes32, bytes32));
        assertEq(gotListUID, listUID, "entry's listUID field = the LIST it joins");
        assertEq(gotTarget, memberKey, "entry's target = the member key");
        assertEq(entryUID, _uid(1));
    }

    function test_AddAddressEntry_PutsMemberInRecipientAndZeroTarget() public {
        vm.startPrank(ALICE);
        bytes32 listUID = consumer.createList(schemas, false, false, 1, bytes32(0), 0); // ADDR mode
        address member = address(0xBEEF);
        consumer.addAddressEntry(schemas, listUID, member);
        vm.stopPrank();

        MockEAS.Call memory e = eas.callAt(1);
        assertEq(e.schema, schemas.listEntry, "schema = LIST_ENTRY");
        assertEq(e.recipient, member, "ADDR mode - member in recipient");
        assertEq(e.refUID, bytes32(0), "refUID 0");
        assertEq(e.data, abi.encode(listUID, bytes32(0)), "ADDR mode - payload target MUST be 0");
    }

    // ── place emits the placement event ──────────────────────────────────────────────────────

    function test_Place_EmitsEFSFileWritten() public {
        bytes32 anchor = keccak256("FILE_ANCHOR_E");
        vm.expectEmit(true, true, false, true, address(consumer));
        emit EFSWriter.EFSFileWritten(anchor, DATA_UID, _uid(0));
        vm.prank(ALICE);
        consumer.place(schemas, anchor, DATA_UID);
    }
}
