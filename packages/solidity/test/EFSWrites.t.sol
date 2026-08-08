// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EFSWriter} from "../src/v1/EFSWriter.sol";
import {EFSLib, IEFSIndexerWrite} from "../src/v1/EFSLib.sol";
import {MockEAS, MockIndexer} from "./EFSWriter.t.sol";

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

    function setPropertyAt(EFSLib.SchemaUIDs memory s, bytes32 keyAnchorUID, string memory v)
        external
        returns (bytes32, bytes32)
    {
        return _efsSetPropertyAt(s, keyAnchorUID, v);
    }

    function place(
        IEFSIndexerWrite indexer,
        EFSLib.SchemaUIDs memory s,
        bytes32 anchor,
        bytes32 data
    ) external returns (bytes32) {
        return _efsPlace(indexer, s, anchor, data);
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

    function setRedirect(
        IEFSIndexerWrite indexer,
        EFSLib.SchemaUIDs memory s,
        bytes32 source,
        bytes32 target,
        uint16 kind
    ) external returns (bytes32) {
        return _efsSetRedirect(indexer, s, source, target, kind);
    }

    function removeRedirect(IEFSIndexerWrite indexer, EFSLib.SchemaUIDs memory s, bytes32 uid)
        external
    {
        _efsRemoveRedirect(indexer, s, uid);
    }
}

contract EFSWritesTest is Test {
    MockEAS eas;
    MockIndexer indexer;
    WritesConsumerMock consumer;

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
    bytes32 constant DATA_UID = keccak256("SOME_DATA");
    bytes32 constant TARGET = keccak256("TAG_TARGET");
    address constant ALICE = address(0xA11CE);

    function setUp() public {
        consumer = new WritesConsumerMock(IEAS(address(eas = new MockEAS())));
        indexer = new MockIndexer();
        // place()'s self-authorship gate reads the DATA's attester — the shared
        // fixture DATA is "authored by" the consumer (the inlined attester).
        eas.seedAuthor(DATA_UID, address(consumer));
        eas.seedSchema(DATA_UID, schemas.data);
        indexer.seedActiveMirrors(DATA_UID, 1); // the readability proof passes by default
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

    /// @notice setPropertyAt refuses a reused definition outside the PROPERTY bucket
    ///         (r3741441639): a PROPERTY bound at a FILE anchor confirms UIDs the
    ///         canonical resolveAnchor(dataUID, key, PROPERTY) lookup never reaches.
    function test_SetPropertyAt_RevertsOnNonPropertyKeyAnchor() public {
        bytes32 fileAnchor = keccak256("A_FILE_ANCHOR_NOT_A_KEY");
        eas.seedSchema(fileAnchor, schemas.anchor);
        eas.seedAnchorSlot(fileAnchor, keccak256("P"), "readme.md", schemas.data); // DATA bucket
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                EFSLib.NotPropertyKeyAnchor.selector, fileAnchor, schemas.anchor, schemas.data
            )
        );
        consumer.setPropertyAt(schemas, fileAnchor, "bob");
    }

    function test_SetPropertyAt_ReusesAnchorOnUpdate() public {
        // An UPDATE must NOT re-mint the permanent key-ANCHOR: it mints only the new
        // PROPERTY + binding-PIN against the supplied (pre-resolved) key-ANCHOR, so the
        // cardinality-1 binding supersedes the prior value. (Re-minting the anchor would
        // revert on the duplicate permanent (DATA, key, PROPERTY) slot — the bug.)
        bytes32 keyAnchorUID = keccak256("EXISTING_KEY_ANCHOR");
        eas.seedSchema(keyAnchorUID, schemas.anchor); // the key-anchor gate (r3741441639)
        eas.seedAnchorSlot(keyAnchorUID, keccak256("SOME_DATA"), "author", schemas.property);
        vm.prank(ALICE);
        (bytes32 propertyUID, bytes32 bindingPinUID) =
            consumer.setPropertyAt(schemas, keyAnchorUID, "bob");

        assertEq(eas.callCount(), 2, "update = PROPERTY + binding-PIN only (no fresh ANCHOR)");

        // 0: PROPERTY (free-floating new value)
        MockEAS.Call memory p = eas.callAt(0);
        assertEq(p.schema, schemas.property, "PROPERTY schema");
        assertEq(p.refUID, bytes32(0), "PROPERTY refUID = 0 (free-floating)");
        assertEq(p.revocable, false, "PROPERTY non-revocable");
        assertEq(p.data, abi.encode("bob"), "PROPERTY data = (new value)");
        assertEq(propertyUID, _uid(0));

        // 1: binding-PIN definition = the EXISTING key-ANCHOR (not a freshly minted one)
        MockEAS.Call memory bp = eas.callAt(1);
        assertEq(bp.schema, schemas.pin, "binding-PIN schema");
        assertEq(bp.refUID, propertyUID, "binding-PIN refUID = PROPERTY (threaded)");
        assertEq(bp.revocable, true, "binding-PIN revocable");
        assertEq(bp.data, abi.encode(keyAnchorUID), "binding-PIN definition = existing key-ANCHOR");
        assertEq(bindingPinUID, _uid(1));
        assertEq(bp.attester, address(consumer), "attester = consumer");
    }

    // ── place (cardinality-1 placement PIN) ──────────────────────────────────────────────────

    function test_Place_BindsDataAtAnchor() public {
        bytes32 anchor = keccak256("FILE_ANCHOR");
        eas.seedSchema(anchor, schemas.anchor);
        eas.seedAnchorSlot(anchor, keccak256("P"), "f.txt", schemas.data);
        vm.prank(ALICE);
        bytes32 pinUID =
            consumer.place(IEFSIndexerWrite(address(indexer)), schemas, anchor, DATA_UID);

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
        eas.seedSchema(anchor, schemas.anchor); // the definition-side gate
        eas.seedAnchorSlot(anchor, keccak256("P"), "f.txt", schemas.data); // DATA bucket
        vm.expectEmit(true, true, false, true, address(consumer));
        emit EFSWriter.EFSFileWritten(anchor, DATA_UID, _uid(0));
        vm.prank(ALICE);
        consumer.place(IEFSIndexerWrite(address(indexer)), schemas, anchor, DATA_UID);
    }

    /// @notice FOREIGN-authored DATA is rejected by the standalone place() too (r3741086781):
    ///         same gate as placeExisting — a foreign placement is visible but unreadable.
    function test_Place_RevertsOnForeignData() public {
        bytes32 foreignData = keccak256("FOREIGN_DATA_FOR_PLACE");
        eas.seedAuthor(foreignData, address(0xBEEF));
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(EFSLib.ForeignDataUID.selector, foreignData, address(0xBEEF))
        );
        consumer.place(
            IEFSIndexerWrite(address(indexer)), schemas, keccak256("SOME_ANCHOR"), foreignData
        );
    }

    /// @notice A SELF-authored DATA with NO active mirror is refused (r3741250936): the
    ///         placement would confirm and every lens-scoped read would fail
    ///         AllMirrorsFailed — ownership proves who minted it, not that the hardlink
    ///         shortcut has metadata to reuse.
    function test_Place_RevertsOnNoActiveMirror() public {
        bytes32 bareData = keccak256("BARE_DATA_NO_MIRRORS");
        eas.seedAuthor(bareData, address(consumer));
        eas.seedSchema(bareData, schemas.data);
        // no seedActiveMirrors — zero mirrors
        bytes32 a = keccak256("A");
        eas.seedSchema(a, schemas.anchor); // pass the definition gate; fail on mirrors
        eas.seedAnchorSlot(a, keccak256("P"), "f.txt", schemas.data);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(EFSLib.NoActiveMirror.selector, bareData, address(consumer))
        );
        consumer.place(IEFSIndexerWrite(address(indexer)), schemas, a, bareData);
    }

    /// @notice place() rejects an ANCHOR outside the DATA file bucket (r3741358639's
    ///         Solidity twin): a generic-folder/PROPERTY-key anchor is undiscoverable
    ///         by file resolution even though it IS an ANCHOR.
    function test_Place_RevertsOnNonFileBucketAnchor() public {
        bytes32 folderAnchor = keccak256("A_GENERIC_FOLDER");
        eas.seedSchema(folderAnchor, schemas.anchor);
        eas.seedAnchorSlot(folderAnchor, keccak256("P"), "docs", bytes32(0)); // generic bucket
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(EFSLib.NotFileBucketAnchor.selector, folderAnchor, bytes32(0))
        );
        consumer.place(IEFSIndexerWrite(address(indexer)), schemas, folderAnchor, DATA_UID);
    }

    /// @notice place() rejects a NON-ANCHOR definition (r3741271349): path resolution
    ///         discovers placements through ANCHOR nodes only.
    function test_Place_RevertsOnNonAnchorDefinition() public {
        bytes32 notAnchor = keccak256("A_PROPERTY_NODE");
        eas.seedSchema(notAnchor, schemas.property);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(EFSLib.NotAnchorUID.selector, notAnchor, schemas.property)
        );
        consumer.place(IEFSIndexerWrite(address(indexer)), schemas, notAnchor, DATA_UID);
    }

    /// @notice place() also rejects a SELF-authored non-DATA target (r3741115243).
    function test_Place_RevertsOnNonDataUID() public {
        bytes32 propUID = keccak256("SELF_AUTHORED_PROPERTY");
        eas.seedAuthor(propUID, address(consumer));
        eas.seedSchema(propUID, schemas.property);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(EFSLib.NotDataUID.selector, propUID, schemas.property)
        );
        consumer.place(
            IEFSIndexerWrite(address(indexer)), schemas, keccak256("SOME_ANCHOR"), propUID
        );
    }

    // ── setRedirect (REDIRECT edge, ADR-0050) ────────────────────────────────────────────────

    function test_SetRedirect_EncodesSourceTargetKind() public {
        bytes32 source = keccak256("DUP_DATA");
        bytes32 target = keccak256("CANONICAL_DATA");
        vm.prank(ALICE);
        bytes32 redirectUID = consumer.setRedirect(
            IEFSIndexerWrite(address(indexer)),
            schemas,
            source,
            target,
            EFSLib.REDIRECT_KIND_SAME_AS
        );

        assertEq(eas.callCount(), 1, "setRedirect = 1 attestation");
        MockEAS.Call memory c = eas.callAt(0);
        assertEq(c.schema, schemas.redirect, "schema = REDIRECT");
        assertEq(c.refUID, source, "source via refUID");
        assertEq(c.revocable, true, "REDIRECT revocable (AliasResolver NotRevocable)");
        assertEq(c.expirationTime, 0, "no expiration (AliasResolver HasExpiration)");
        assertEq(c.recipient, address(0), "recipient 0");
        // (target, kind) - 64 bytes exact (uint16 pads to a word).
        assertEq(c.data, abi.encode(target, EFSLib.REDIRECT_KIND_SAME_AS), "data = (target, kind)");
        assertEq(c.data.length, 64, "REDIRECT payload is canonical 64 bytes");
        assertEq(redirectUID, _uid(0), "returns the minted redirect UID");
        assertEq(c.attester, address(consumer), "attester = consumer (inlined lens)");
    }

    function test_SetRedirect_DecodesBackToInputs() public {
        bytes32 source = keccak256("SRC");
        bytes32 target = keccak256("TGT");
        vm.prank(ALICE);
        consumer.setRedirect(
            IEFSIndexerWrite(address(indexer)),
            schemas,
            source,
            target,
            EFSLib.REDIRECT_KIND_SYMLINK
        );
        (bytes32 gotTarget, uint16 gotKind) = abi.decode(eas.callAt(0).data, (bytes32, uint16));
        assertEq(gotTarget, target, "target round-trips");
        assertEq(gotKind, EFSLib.REDIRECT_KIND_SYMLINK, "kind round-trips");
    }

    /// @notice A symlink DIRECTLY at a bare/foreign-metadata DATA is refused
    ///         (r3741562779): resolvedBy is the redirect author, whose lens then has
    ///         no retrieval URI — the same NoActiveMirror floor as the placements.
    function test_SetRedirect_RevertsOnSymlinkToBareData() public {
        bytes32 bareData = keccak256("BARE_DATA_SYMLINK_TARGET");
        eas.seedSchema(bareData, schemas.data);
        // no seedActiveMirrors — the author holds none
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(EFSLib.NoActiveMirror.selector, bareData, address(consumer))
        );
        consumer.setRedirect(
            IEFSIndexerWrite(address(indexer)),
            schemas,
            keccak256("SRC_ANCHOR"),
            bareData,
            EFSLib.REDIRECT_KIND_SYMLINK
        );
    }

    /// @notice A symlink at a DATA the author mirrors passes; ANCHOR targets skip the gate.
    function test_SetRedirect_SymlinkGatePassesWithMirrorOrAnchorTarget() public {
        bytes32 mirroredData = keccak256("MIRRORED_DATA_TARGET");
        eas.seedSchema(mirroredData, schemas.data);
        indexer.seedActiveMirrors(mirroredData, 1);
        vm.prank(ALICE);
        consumer.setRedirect(
            IEFSIndexerWrite(address(indexer)),
            schemas,
            keccak256("SRC_A"),
            mirroredData,
            EFSLib.REDIRECT_KIND_SYMLINK
        );
        // ANCHOR target (seeded as anchor schema): the walk carries its own metadata.
        bytes32 anchorTarget = keccak256("ANCHOR_TARGET");
        eas.seedSchema(anchorTarget, schemas.anchor);
        vm.prank(ALICE);
        consumer.setRedirect(
            IEFSIndexerWrite(address(indexer)),
            schemas,
            keccak256("SRC_B"),
            anchorTarget,
            EFSLib.REDIRECT_KIND_SYMLINK
        );
        assertEq(indexer.indexedCount(), 2, "both symlinks attested + indexed");
    }

    /// @notice ADR-0017 lifecycle, first leg (r3741057696): setRedirect must call
    ///         `indexer.index(redirectUID)` in the SAME transaction — AliasResolver never
    ///         populates the referencing index, so an un-indexed redirect is invisible to
    ///         every SDK discovery read (get/list/canonical/history/symlink walk).
    function test_SetRedirect_IndexesAtomically() public {
        vm.prank(ALICE);
        bytes32 redirectUID = consumer.setRedirect(
            IEFSIndexerWrite(address(indexer)),
            schemas,
            keccak256("SRC"),
            keccak256("TGT"),
            EFSLib.REDIRECT_KIND_SAME_AS
        );
        assertEq(indexer.indexedCount(), 1, "one same-tx index() call");
        assertEq(indexer.indexedUIDs(0), redirectUID, "index() got the minted redirect UID");
        assertEq(indexer.revocationMirroredCount(), 0, "no revocation leg on set");
    }

    /// @notice ADR-0017 lifecycle, second leg: removeRedirect revokes under the REDIRECT
    ///         schema AND mirrors the revocation in the same transaction — a bare
    ///         `eas.revoke()` would leave the redirect SERVED by filtered reads.
    function test_RemoveRedirect_RevokesAndMirrorsAtomically() public {
        bytes32 redirectUID = keccak256("EXISTING_REDIRECT");
        vm.prank(ALICE);
        consumer.removeRedirect(IEFSIndexerWrite(address(indexer)), schemas, redirectUID);
        assertEq(eas.revocationCount(), 1, "one EAS revocation");
        MockEAS.Revocation memory r = eas.revocationAt(0);
        assertEq(r.schema, schemas.redirect, "revoked under the REDIRECT schema");
        assertEq(r.uid, redirectUID, "revoked the right UID");
        assertEq(indexer.revocationMirroredCount(), 1, "one same-tx indexRevocation() call");
        assertEq(indexer.revocationMirroredUIDs(0), redirectUID, "mirrored the right UID");
        assertEq(indexer.indexedCount(), 0, "no index leg on remove");
    }
}
