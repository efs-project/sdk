// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {
    IEAS,
    AttestationRequest,
    DelegatedAttestationRequest,
    MultiAttestationRequest,
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
import {
    EFSReader,
    IEFSIndexerRead,
    IEdgeResolverRead,
    IEFSFileViewRead,
    IListReaderRead
} from "../src/v1/EFSReader.sol";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mock view contracts. EFSReader forwards into these through the `view`-declared read interfaces,
// so Solidity uses STATICCALL — the mock read functions MUST stay `view` (no storage writes during
// the call). Each read returns a value SCRIPTED ON ITS ARGS (keyed mapping), so a wrapper test that
// gets the scripted value back proves the wrapper forwarded every argument correctly: a wrong
// definition/attester/schema keys a different (or zero) slot. Mirrors the EFSWriter.t.sol spy idea,
// adapted for view (key-on-args instead of record-the-call).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// @dev Spy `EFSIndexer` read surface. `resolvePath`/`resolveAnchor` return a scripted UID keyed
///      on their full argument tuple; unmapped lookups return EMPTY_UID (a missing segment).
contract MockIndexer {
    mapping(bytes32 => bytes32) public pathReturns; // keccak(parent,name) => child (Generic)
    mapping(bytes32 => bytes32) public anchorReturns; // keccak(parent,name,schema) => child

    function setPath(bytes32 parent, string memory name, bytes32 child) external {
        pathReturns[keccak256(abi.encode(parent, name))] = child;
    }

    function setAnchor(bytes32 parent, string memory name, bytes32 schema, bytes32 child) external {
        anchorReturns[keccak256(abi.encode(parent, name, schema))] = child;
    }

    function resolvePath(bytes32 parentUID, string calldata name) external view returns (bytes32) {
        return pathReturns[keccak256(abi.encode(parentUID, name))];
    }

    function resolveAnchor(bytes32 parentUID, string calldata name, bytes32 schema)
        external
        view
        returns (bytes32)
    {
        return anchorReturns[keccak256(abi.encode(parentUID, name, schema))];
    }

    function DATA_SCHEMA_UID() external pure returns (bytes32) {
        return keccak256("DATA_SCHEMA");
    }

    function ANCHOR_SCHEMA_UID() external pure returns (bytes32) {
        return keccak256("ANCHOR_SCHEMA");
    }

    function PROPERTY_SCHEMA_UID() external pure returns (bytes32) {
        return keccak256("PROPERTY_SCHEMA");
    }
}

/// @dev Spy `EdgeResolver` PIN read surface. Returns a scripted SlotEntry keyed on the full
///      (definition, attester, schema) slot tuple.
contract MockEdgeResolver {
    mapping(bytes32 => IEdgeResolverRead.SlotEntry) internal slots;

    function _key(bytes32 def, address att, bytes32 schema) internal pure returns (bytes32) {
        return keccak256(abi.encode(def, att, schema));
    }

    function setSlot(bytes32 def, address att, bytes32 schema, bytes32 pinUID, bytes32 targetID)
        external
    {
        slots[_key(def, att, schema)] =
            IEdgeResolverRead.SlotEntry({pinUID: pinUID, targetID: targetID});
    }

    function getActivePinTarget(bytes32 definition, address attester, bytes32 targetSchema)
        external
        view
        returns (bytes32)
    {
        return slots[_key(definition, attester, targetSchema)].targetID;
    }

    function getActivePinSlot(bytes32 definition, address attester, bytes32 targetSchema)
        external
        view
        returns (IEdgeResolverRead.SlotEntry memory)
    {
        return slots[_key(definition, attester, targetSchema)];
    }
}

/// @dev Spy `EFSFileView` read surface. Echoes the forwarded args back inside the returned page so
///      the wrapper test can assert they were threaded correctly through a single STATICCALL.
contract MockFileView {
    IEFSFileViewRead.FileSystemItem[] internal items;
    bytes internal cannedCursor;

    function setItems(IEFSFileViewRead.FileSystemItem[] memory it, bytes memory nextCursor)
        external
    {
        delete items;
        for (uint256 i = 0; i < it.length; i++) {
            items.push(it[i]);
        }
        cannedCursor = nextCursor;
    }

    function getFilesAtPath(
        bytes32 anchorUID,
        address[] calldata attesters,
        bytes32 schema,
        bytes calldata cursor,
        uint256 maxItems
    ) external view returns (IEFSFileViewRead.DirectoryPage memory page) {
        page.items = items;
        // Echo the forwarded args into the opaque cursor so the test can decode + assert them.
        page.nextCursor = abi.encode(
            anchorUID, keccak256(abi.encode(attesters)), schema, cursor, maxItems, cannedCursor
        );
    }

    // The directory-listing method `listChildren` now forwards to — echoes args the same way.
    function getDirectoryPageBySchemaAndAddressList(
        bytes32 parentAnchor,
        bytes32 anchorSchema,
        address[] calldata attesters,
        bytes calldata cursor,
        uint256 maxItems
    ) external view returns (IEFSFileViewRead.DirectoryPage memory page) {
        page.items = items;
        page.nextCursor = abi.encode(
            parentAnchor,
            keccak256(abi.encode(attesters)),
            anchorSchema,
            cursor,
            maxItems,
            cannedCursor
        );
    }
}

/// @dev Spy `ListReader` read surface. Scripted mode/length/entries; length/entries echo their lens
///      arg into the return so the wrapper test can assert forwarding.
contract MockListReader {
    IListReaderRead.ListMode internal mode;
    IListReaderRead.Entry[] internal entriesStore;
    mapping(bytes32 => uint256) internal lengthByKey; // keccak(listUID,attester) => length

    function setMode(IListReaderRead.ListMode memory m) external {
        mode = m;
    }

    function setLength(bytes32 listUID, address attester, uint256 n) external {
        lengthByKey[keccak256(abi.encode(listUID, attester))] = n;
    }

    function setEntries(IListReaderRead.Entry[] memory e) external {
        delete entriesStore;
        for (uint256 i = 0; i < e.length; i++) {
            entriesStore.push(e[i]);
        }
    }

    function getMode(bytes32 listUID) external view returns (IListReaderRead.ListMode memory m) {
        m = mode;
        // Echo the forwarded listUID into the (otherwise unused) targetSchema field for assertion.
        m.targetSchema = listUID;
    }

    function length(bytes32 listUID, address attester) external view returns (uint256) {
        return lengthByKey[keccak256(abi.encode(listUID, attester))];
    }

    function entries(bytes32 listUID, address attester, uint256 start, uint256 len)
        external
        view
        returns (IListReaderRead.Entry[] memory res)
    {
        res = entriesStore;
        // Echo start/len/attester into a synthetic trailing entry so forwarding is assertable.
        // (Tests below set entriesStore so this echo never collides with real data indices.)
        if (res.length > 0) {
            res[res.length - 1].entryUID =
                keccak256(abi.encode(listUID, attester, start, len, "ECHO"));
        }
    }
}

/// @dev `MockEAS` exposing only `getAttestation` (the one read EFSReader needs). The rest of IEAS
///      reverts as unused. `getAttestation` is `view` — matching the real signature.
contract MockEAS is IEAS {
    mapping(bytes32 => Attestation) internal attestations;

    function setAttestation(bytes32 uid, bytes32 schema, bytes memory data) external {
        Attestation storage a = attestations[uid];
        a.uid = uid;
        a.schema = schema;
        a.data = data;
    }

    /// @dev Richer setter for REDIRECT reads, which lens-scope on `attester`, exclude on
    ///      `revocationTime`, and read the source from `refUID` (none of which the 3-arg setter
    ///      covers). `revocationTime != 0` marks the attestation revoked.
    function setRedirectAttestation(
        bytes32 uid,
        bytes32 schema,
        bytes32 refUID,
        address attester,
        uint64 revocationTime,
        bytes memory data
    ) external {
        Attestation storage a = attestations[uid];
        a.uid = uid;
        a.schema = schema;
        a.refUID = refUID;
        a.attester = attester;
        a.revocationTime = revocationTime;
        a.data = data;
    }

    function getAttestation(bytes32 uid) external view returns (Attestation memory) {
        return attestations[uid];
    }

    // ── Unused IEAS surface — revert if ever hit ──────────────────────────────────────────────
    function getSchemaRegistry() external pure returns (ISchemaRegistry) {
        revert("unused");
    }

    function attest(AttestationRequest calldata) external payable returns (bytes32) {
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

contract EFSReaderTest is Test {
    MockIndexer indexer;
    MockEdgeResolver edge;
    MockFileView fileView;
    MockListReader listReader;
    MockEAS eas;

    bytes32 constant ROOT = keccak256("ROOT_ANCHOR");
    bytes32 constant DATA_SCHEMA = keccak256("DATA_SCHEMA");
    bytes32 constant PROPERTY_SCHEMA = keccak256("PROPERTY_SCHEMA");
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function setUp() public {
        indexer = new MockIndexer();
        edge = new MockEdgeResolver();
        fileView = new MockFileView();
        listReader = new MockListReader();
        eas = new MockEAS();
    }

    function _indexer() internal view returns (IEFSIndexerRead) {
        return IEFSIndexerRead(address(indexer));
    }

    function _edge() internal view returns (IEdgeResolverRead) {
        return IEdgeResolverRead(address(edge));
    }

    // ── resolveAnchor / resolvePath ──────────────────────────────────────────────────────────

    function test_ResolveAnchor_Generic_ForwardsAndReturns() public {
        bytes32 child = keccak256("docs_anchor");
        indexer.setPath(ROOT, "docs", child);

        // Correct (parent, name) returns the scripted child — proves both args forwarded.
        assertEq(EFSReader.resolveAnchor(_indexer(), ROOT, "docs"), child, "scripted child");
        // A different parent or name keys nothing => EMPTY_UID (negative control).
        assertEq(EFSReader.resolveAnchor(_indexer(), child, "docs"), bytes32(0), "wrong parent");
        assertEq(EFSReader.resolveAnchor(_indexer(), ROOT, "other"), bytes32(0), "wrong name");
    }

    function test_ResolveAnchor_TypedSchema_ForwardsSchema() public {
        bytes32 schema = keccak256("CUSTOM_FOR_SCHEMA");
        bytes32 child = keccak256("typed_child");
        indexer.setAnchor(ROOT, "thing", schema, child);

        assertEq(EFSReader.resolveAnchor(_indexer(), ROOT, "thing", schema), child, "typed child");
        // Wrong schema keys nothing — proves the schema arg is forwarded, not dropped.
        assertEq(
            EFSReader.resolveAnchor(_indexer(), ROOT, "thing", bytes32(0)),
            bytes32(0),
            "wrong schema => empty"
        );
    }

    function test_ResolveAnchor_Missing_ReturnsEmpty() public view {
        assertEq(EFSReader.resolveAnchor(_indexer(), ROOT, "nope"), bytes32(0), "absent => EMPTY");
    }

    function test_ResolvePath_MultiSegment_WalksToTerminal() public {
        bytes32 docs = keccak256("docs_anchor");
        bytes32 readme = keccak256("readme_anchor");
        indexer.setPath(ROOT, "docs", docs);
        indexer.setPath(docs, "readme.txt", readme);

        string[] memory segs = new string[](2);
        segs[0] = "docs";
        segs[1] = "readme.txt";

        // Terminal anchor requires BOTH hops threaded correctly (docs UID -> readme lookup).
        assertEq(EFSReader.resolvePath(_indexer(), ROOT, segs), readme, "ROOT->docs->readme");
    }

    function test_ResolvePath_MissingMiddle_ReturnsEmpty() public {
        bytes32 docs = keccak256("docs_anchor");
        indexer.setPath(ROOT, "docs", docs);
        // "missing" under docs is unset => EMPTY_UID, short-circuits before "deeper".

        string[] memory segs = new string[](3);
        segs[0] = "docs";
        segs[1] = "missing";
        segs[2] = "deeper";

        assertEq(
            EFSReader.resolvePath(_indexer(), ROOT, segs), bytes32(0), "missing middle => EMPTY"
        );
    }

    function test_ResolvePath_EmptySegments_ReturnsRoot() public view {
        string[] memory segs = new string[](0);
        assertEq(EFSReader.resolvePath(_indexer(), ROOT, segs), ROOT, "empty path => root");
    }

    // ── activePin / activePinSlot ────────────────────────────────────────────────────────────

    function test_ActivePin_ForwardsSlotAndReturnsTarget() public {
        bytes32 fileAnchor = keccak256("file_anchor");
        bytes32 dataUID = keccak256("data_uid");
        edge.setSlot(fileAnchor, ALICE, DATA_SCHEMA, keccak256("pin"), dataUID);

        assertEq(EFSReader.activePin(_edge(), fileAnchor, ALICE, DATA_SCHEMA), dataUID, "target");
        // Each slot arg matters: wrong anchor/attester/schema => empty (negative controls).
        assertEq(EFSReader.activePin(_edge(), dataUID, ALICE, DATA_SCHEMA), bytes32(0), "wrong def");
        assertEq(
            EFSReader.activePin(_edge(), fileAnchor, BOB, DATA_SCHEMA), bytes32(0), "wrong att"
        );
        assertEq(
            EFSReader.activePin(_edge(), fileAnchor, ALICE, bytes32(0)), bytes32(0), "wrong schema"
        );
    }

    function test_ActivePin_LensScoped_DistinctPerAttester() public {
        bytes32 fileAnchor = keccak256("file_anchor");
        edge.setSlot(fileAnchor, ALICE, DATA_SCHEMA, keccak256("pinA"), keccak256("dataA"));
        edge.setSlot(fileAnchor, BOB, DATA_SCHEMA, keccak256("pinB"), keccak256("dataB"));

        assertEq(
            EFSReader.activePin(_edge(), fileAnchor, ALICE, DATA_SCHEMA),
            keccak256("dataA"),
            "Alice's placement"
        );
        assertEq(
            EFSReader.activePin(_edge(), fileAnchor, BOB, DATA_SCHEMA),
            keccak256("dataB"),
            "Bob's placement (lens-scoped, different)"
        );
    }

    function test_ActivePin_Empty_ReturnsEmpty() public view {
        assertEq(
            EFSReader.activePin(_edge(), keccak256("nope"), ALICE, DATA_SCHEMA),
            bytes32(0),
            "no PIN => EMPTY_UID"
        );
    }

    function test_ActivePinSlot_ReturnsPinAndTarget() public {
        bytes32 fileAnchor = keccak256("file_anchor");
        bytes32 pinUID = keccak256("the_pin");
        bytes32 dataUID = keccak256("the_data");
        edge.setSlot(fileAnchor, ALICE, DATA_SCHEMA, pinUID, dataUID);

        IEdgeResolverRead.SlotEntry memory slot =
            EFSReader.activePinSlot(_edge(), fileAnchor, ALICE, DATA_SCHEMA);
        assertEq(slot.pinUID, pinUID, "slot.pinUID");
        assertEq(slot.targetID, dataUID, "slot.targetID");
    }

    // ── propertyValue (the one decode) ───────────────────────────────────────────────────────

    function test_PropertyValue_DecodeRoundTrips() public {
        bytes32 keyAnchor = keccak256("contentType_anchor");
        bytes32 propertyUID = keccak256("property_uid");
        string memory value = "text/markdown";

        // Binding PIN: keyAnchor -> propertyUID, lens=ALICE, target schema = PROPERTY.
        edge.setSlot(keyAnchor, ALICE, PROPERTY_SCHEMA, keccak256("bindingPin"), propertyUID);
        // PROPERTY attestation carries abi.encode(value) (matches EFSLib write encoding).
        eas.setAttestation(propertyUID, PROPERTY_SCHEMA, abi.encode(value));

        string memory got =
            EFSReader.propertyValue(_edge(), IEAS(address(eas)), keyAnchor, ALICE, PROPERTY_SCHEMA);

        assertEq(got, value, "decoded PROPERTY string round-trips through the wrapper");
    }

    function test_PropertyValue_Unbound_ReturnsEmpty() public view {
        // No binding PIN set for this key anchor — wrapper must short-circuit before any eas read.
        string memory got = EFSReader.propertyValue(
            _edge(), IEAS(address(eas)), keccak256("unbound_key"), ALICE, PROPERTY_SCHEMA
        );
        assertEq(bytes(got).length, 0, "unbound key => empty string");
    }

    function test_PropertyValue_EmptyData_ReturnsEmpty() public {
        bytes32 keyAnchor = keccak256("key");
        bytes32 propertyUID = keccak256("prop");
        edge.setSlot(keyAnchor, ALICE, PROPERTY_SCHEMA, keccak256("pin"), propertyUID);
        // PROPERTY exists but has zero-length data — must NOT revert on abi.decode.
        eas.setAttestation(propertyUID, PROPERTY_SCHEMA, "");

        string memory got =
            EFSReader.propertyValue(_edge(), IEAS(address(eas)), keyAnchor, ALICE, PROPERTY_SCHEMA);
        assertEq(bytes(got).length, 0, "empty PROPERTY data => empty string, no revert");
    }

    function test_PropertyValue_LensScoped() public {
        bytes32 keyAnchor = keccak256("name_anchor");
        bytes32 propA = keccak256("propA");
        bytes32 propB = keccak256("propB");
        edge.setSlot(keyAnchor, ALICE, PROPERTY_SCHEMA, keccak256("pinA"), propA);
        edge.setSlot(keyAnchor, BOB, PROPERTY_SCHEMA, keccak256("pinB"), propB);
        eas.setAttestation(propA, PROPERTY_SCHEMA, abi.encode("alice-name"));
        eas.setAttestation(propB, PROPERTY_SCHEMA, abi.encode("bob-name"));

        assertEq(
            EFSReader.propertyValue(_edge(), IEAS(address(eas)), keyAnchor, ALICE, PROPERTY_SCHEMA),
            "alice-name",
            "Alice's bound value"
        );
        assertEq(
            EFSReader.propertyValue(_edge(), IEAS(address(eas)), keyAnchor, BOB, PROPERTY_SCHEMA),
            "bob-name",
            "Bob's bound value (lens-scoped)"
        );
    }

    // ── listChildren ─────────────────────────────────────────────────────────────────────────

    function test_ListChildren_ForwardsArgsAndReturnsPage() public {
        bytes32 anchor = keccak256("dir_anchor");

        IEFSFileViewRead.FileSystemItem[] memory items = new IEFSFileViewRead.FileSystemItem[](1);
        items[0].uid = keccak256("item0");
        items[0].name = "readme.txt";
        items[0].attester = ALICE;
        fileView.setItems(items, abi.encode(uint256(42)));

        address[] memory attesters = new address[](2);
        attesters[0] = ALICE;
        attesters[1] = BOB;

        IEFSFileViewRead.DirectoryPage memory page = EFSReader.listChildren(
            IEFSFileViewRead(address(fileView)), anchor, attesters, DATA_SCHEMA, hex"", 10
        );

        // Items returned verbatim.
        assertEq(page.items.length, 1, "items length");
        assertEq(page.items[0].name, "readme.txt", "item name preserved");
        assertEq(page.items[0].attester, ALICE, "item attester preserved");

        // The mock echoed every forwarded arg into nextCursor — decode + assert each.
        (
            bytes32 gotAnchor,
            bytes32 gotAttestersHash,
            bytes32 gotSchema,
            bytes memory gotCursor,
            uint256 gotMax,
            bytes memory gotCanned
        ) = abi.decode(page.nextCursor, (bytes32, bytes32, bytes32, bytes, uint256, bytes));

        assertEq(gotAnchor, anchor, "forwarded anchor");
        assertEq(gotAttestersHash, keccak256(abi.encode(attesters)), "forwarded attesters list");
        assertEq(gotSchema, DATA_SCHEMA, "forwarded schema");
        assertEq(gotCursor.length, 0, "forwarded empty cursor");
        assertEq(gotMax, 10, "forwarded max");
        assertEq(gotCanned, abi.encode(uint256(42)), "canned nextCursor surfaced");
    }

    // ── list reads ───────────────────────────────────────────────────────────────────────────

    function test_ListMode_Forwards() public {
        IListReaderRead.ListMode memory m = IListReaderRead.ListMode({
            exists: true,
            curator: ALICE,
            allowsDuplicates: false,
            appendOnly: true,
            targetType: 1,
            targetSchema: bytes32(0),
            maxEntries: 100
        });
        listReader.setMode(m);

        bytes32 listUID = keccak256("list");
        IListReaderRead.ListMode memory got =
            EFSReader.listMode(IListReaderRead(address(listReader)), listUID);

        assertTrue(got.exists, "exists");
        assertEq(got.curator, ALICE, "curator");
        assertEq(got.targetType, 1, "targetType");
        assertEq(got.maxEntries, 100, "maxEntries");
        // Mock echoed the forwarded listUID into targetSchema.
        assertEq(got.targetSchema, listUID, "forwarded listUID");
    }

    function test_ListLength_Forwards() public {
        bytes32 listUID = keccak256("list");
        listReader.setLength(listUID, ALICE, 7);

        // Correct (listUID, attester) returns the scripted length — proves both forwarded.
        assertEq(
            EFSReader.listLength(IListReaderRead(address(listReader)), listUID, ALICE), 7, "len"
        );
        // Wrong lens keys a different slot => 0 (lens-scoped negative control).
        assertEq(
            EFSReader.listLength(IListReaderRead(address(listReader)), listUID, BOB),
            0,
            "wrong lens => 0"
        );
    }

    function test_ListEntries_ForwardsAndReturns() public {
        IListReaderRead.Entry[] memory entries = new IListReaderRead.Entry[](2);
        entries[0] = IListReaderRead.Entry({
            entryUID: keccak256("e0"), targetType: 1, identityKey: bytes32(uint256(uint160(BOB)))
        });
        entries[1] = IListReaderRead.Entry({
            entryUID: keccak256("e1"), targetType: 1, identityKey: bytes32(uint256(uint160(ALICE)))
        });
        listReader.setEntries(entries);

        bytes32 listUID = keccak256("list");
        IListReaderRead.Entry[] memory got =
            EFSReader.listEntries(IListReaderRead(address(listReader)), listUID, ALICE, 3, 50);

        assertEq(got.length, 2, "returns entries");
        assertEq(got[0].entryUID, keccak256("e0"), "entry 0 uid preserved");
        assertEq(got[0].identityKey, bytes32(uint256(uint160(BOB))), "entry 0 identityKey");
        // The mock echoed (listUID, attester, start, len) into the last entry's uid — proves
        // every forwarded arg threaded through.
        assertEq(
            got[1].entryUID,
            keccak256(abi.encode(listUID, ALICE, uint256(3), uint256(50), "ECHO")),
            "forwarded listUID/attester/start/len"
        );
    }

    // ── REDIRECT resolution (ADR-0050) ─────────────────────────────────────────────────────────

    bytes32 constant REDIRECT_SCHEMA = keccak256("REDIRECT_SCHEMA");

    /// @dev Mint a REDIRECT attestation `uid`: source `src` → target `tgt`, class `kind`, asserted
    ///      by `attester`, active (not revoked). Payload is the frozen `(bytes32 target, uint16 kind)`.
    function _redirect(bytes32 uid, bytes32 src, bytes32 tgt, uint16 kind, address attester)
        internal
    {
        eas.setRedirectAttestation(uid, REDIRECT_SCHEMA, src, attester, 0, abi.encode(tgt, kind));
    }

    function _eas() internal view returns (IEAS) {
        return IEAS(address(eas));
    }

    /// @dev External trampoline so `vm.expectRevert` latches onto THIS call's revert, not the
    ///      inner `eas.getAttestation` staticcall the inlined library makes first (a depth-0
    ///      internal-library revert otherwise lets expectRevert catch the first external call
    ///      instead). Revert-path tests call through here; happy-path tests call the lib directly.
    function resolveWithRedirectsExt(
        bytes32 source,
        bytes32[] memory redirectUIDs,
        address attester,
        uint256 maxHops
    ) external view returns (bytes32, uint256) {
        return EFSReader.resolveWithRedirects(
            _eas(), REDIRECT_SCHEMA, source, redirectUIDs, attester, maxHops
        );
    }

    // followKind — only sameAs/supersededBy/symlink auto-follow.
    function test_FollowKind_OnlyEnforcedKindsFollow() public pure {
        assertTrue(EFSReader.followKind(EFSReader.REDIRECT_KIND_SAME_AS), "sameAs follows");
        assertTrue(
            EFSReader.followKind(EFSReader.REDIRECT_KIND_SUPERSEDED_BY), "supersededBy follows"
        );
        assertTrue(EFSReader.followKind(EFSReader.REDIRECT_KIND_SYMLINK), "symlink follows");
        assertFalse(
            EFSReader.followKind(EFSReader.REDIRECT_KIND_RELATED_VERSION), "relatedVersion never"
        );
        assertFalse(EFSReader.followKind(99), "reserved kind never");
    }

    // redirectTarget — decode + lens/schema/revocation guards.
    function test_RedirectTarget_DecodesActiveLensRedirect() public {
        bytes32 rUID = keccak256("r1");
        bytes32 src = keccak256("dataA");
        bytes32 tgt = keccak256("dataCanonical");
        _redirect(rUID, src, tgt, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);

        (bytes32 gotSrc, bytes32 gotTgt, uint16 gotKind) =
            EFSReader.redirectTarget(_eas(), REDIRECT_SCHEMA, rUID, ALICE);
        assertEq(gotSrc, src, "source = refUID");
        assertEq(gotTgt, tgt, "target decoded");
        assertEq(gotKind, EFSReader.REDIRECT_KIND_SAME_AS, "kind decoded");
    }

    function test_RedirectTarget_ForeignAttester_NotApplicable() public {
        bytes32 rUID = keccak256("r1");
        _redirect(rUID, keccak256("s"), keccak256("t"), EFSReader.REDIRECT_KIND_SAME_AS, ALICE);
        // Reading under BOB's lens: Alice's redirect does not apply.
        (bytes32 s, bytes32 t, uint16 k) =
            EFSReader.redirectTarget(_eas(), REDIRECT_SCHEMA, rUID, BOB);
        assertEq(s, bytes32(0), "foreign lens => empty source");
        assertEq(t, bytes32(0), "foreign lens => empty target");
        assertEq(k, 0, "foreign lens => kind 0");
    }

    function test_RedirectTarget_WrongSchema_NotApplicable() public {
        bytes32 rUID = keccak256("r1");
        // Right field shape, but a DIFFERENT schema pointed at the payload — must be rejected.
        eas.setRedirectAttestation(
            rUID,
            keccak256("NOT_REDIRECT_SCHEMA"),
            keccak256("s"),
            ALICE,
            0,
            abi.encode(keccak256("t"), uint16(0))
        );
        (, bytes32 t,) = EFSReader.redirectTarget(_eas(), REDIRECT_SCHEMA, rUID, ALICE);
        assertEq(t, bytes32(0), "wrong schema => not a redirect");
    }

    function test_RedirectTarget_Revoked_NotApplicable() public {
        bytes32 rUID = keccak256("r1");
        // revocationTime != 0 => revoked => inactive (ADR-0051).
        eas.setRedirectAttestation(
            rUID,
            REDIRECT_SCHEMA,
            keccak256("s"),
            ALICE,
            12345,
            abi.encode(keccak256("t"), uint16(0))
        );
        (, bytes32 t,) = EFSReader.redirectTarget(_eas(), REDIRECT_SCHEMA, rUID, ALICE);
        assertEq(t, bytes32(0), "revoked => not a redirect");
    }

    function test_RedirectTarget_Absent_NotApplicable() public view {
        (, bytes32 t,) = EFSReader.redirectTarget(_eas(), REDIRECT_SCHEMA, keccak256("nope"), ALICE);
        assertEq(t, bytes32(0), "absent UID => empty");
    }

    // resolveWithRedirects — single hop.
    function test_ResolveWithRedirects_SingleHop() public {
        bytes32 src = keccak256("dataDup");
        bytes32 canon = keccak256("dataCanon");
        bytes32 rUID = keccak256("r1");
        _redirect(rUID, src, canon, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);

        bytes32[] memory chain = new bytes32[](1);
        chain[0] = rUID;
        (bytes32 terminal, uint256 hops) =
            EFSReader.resolveWithRedirects(_eas(), REDIRECT_SCHEMA, src, chain, ALICE, 0);
        assertEq(terminal, canon, "follows one hop to canonical");
        assertEq(hops, 1, "one hop followed");
    }

    // resolveWithRedirects — multi hop A→B→C.
    function test_ResolveWithRedirects_MultiHop() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        bytes32 c = keccak256("C");
        _redirect(keccak256("rAB"), a, b, EFSReader.REDIRECT_KIND_SUPERSEDED_BY, ALICE);
        _redirect(keccak256("rBC"), b, c, EFSReader.REDIRECT_KIND_SUPERSEDED_BY, ALICE);

        bytes32[] memory chain = new bytes32[](2);
        chain[0] = keccak256("rAB");
        chain[1] = keccak256("rBC");
        (bytes32 terminal, uint256 hops) =
            EFSReader.resolveWithRedirects(_eas(), REDIRECT_SCHEMA, a, chain, ALICE, 0);
        assertEq(terminal, c, "follows A->B->C to terminal");
        assertEq(hops, 2, "two hops followed");
    }

    // resolveWithRedirects — a hostile `maxHops` is clamped to the 32-hop ceiling, so it
    // cannot overflow `cap + 1` or force a giant `visited` allocation (Codex review).
    function test_ResolveWithRedirects_ClampsHostileMaxHops() public view {
        bytes32 src = keccak256("loner");
        bytes32[] memory none = new bytes32[](0);
        // Unclamped, `type(uint256).max + 1` would wrap to 0 → `new bytes32[](0)` → the
        // `visited[0] = source` write would revert out-of-bounds. The clamp makes it safe.
        (bytes32 terminal, uint256 hops) = EFSReader.resolveWithRedirects(
            _eas(), REDIRECT_SCHEMA, src, none, ALICE, type(uint256).max
        );
        assertEq(terminal, src, "no redirects -> terminal is the source");
        assertEq(hops, 0, "no hops followed");
    }

    // resolveWithRedirects — no redirect (passthrough): empty chain returns source.
    function test_ResolveWithRedirects_NoRedirect_Passthrough() public view {
        bytes32 src = keccak256("loneData");
        bytes32[] memory chain = new bytes32[](0);
        (bytes32 terminal, uint256 hops) =
            EFSReader.resolveWithRedirects(_eas(), REDIRECT_SCHEMA, src, chain, ALICE, 0);
        assertEq(terminal, src, "no redirects => source unchanged");
        assertEq(hops, 0, "zero hops");
    }

    // resolveWithRedirects — a supplied redirect that doesn't apply (revoked) stops at the cursor.
    function test_ResolveWithRedirects_InapplicableHop_StopsAtCursor() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        bytes32 c = keccak256("C");
        _redirect(keccak256("rAB"), a, b, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);
        // Second hop is REVOKED — walk should stop at B, not error, not reach C.
        eas.setRedirectAttestation(
            keccak256("rBC"), REDIRECT_SCHEMA, b, ALICE, 999, abi.encode(c, uint16(0))
        );

        bytes32[] memory chain = new bytes32[](2);
        chain[0] = keccak256("rAB");
        chain[1] = keccak256("rBC");
        (bytes32 terminal, uint256 hops) =
            EFSReader.resolveWithRedirects(_eas(), REDIRECT_SCHEMA, a, chain, ALICE, 0);
        assertEq(terminal, b, "stops at B (second hop inactive)");
        assertEq(hops, 1, "only first hop followed");
    }

    // resolveWithRedirects — a non-followable kind (relatedVersion) stops without following.
    function test_ResolveWithRedirects_NonFollowableKind_Stops() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        _redirect(keccak256("rAB"), a, b, EFSReader.REDIRECT_KIND_RELATED_VERSION, ALICE);

        bytes32[] memory chain = new bytes32[](1);
        chain[0] = keccak256("rAB");
        (bytes32 terminal, uint256 hops) =
            EFSReader.resolveWithRedirects(_eas(), REDIRECT_SCHEMA, a, chain, ALICE, 0);
        assertEq(terminal, a, "relatedVersion is a hint, not followed");
        assertEq(hops, 0, "zero hops followed");
    }

    // resolveWithRedirects — cycle A→B→A reverts.
    function test_ResolveWithRedirects_Cycle_Reverts() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        _redirect(keccak256("rAB"), a, b, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);
        _redirect(keccak256("rBA"), b, a, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);

        bytes32[] memory chain = new bytes32[](2);
        chain[0] = keccak256("rAB");
        chain[1] = keccak256("rBA");
        vm.expectRevert(abi.encodeWithSelector(EFSReader.RedirectCycle.selector, a));
        this.resolveWithRedirectsExt(a, chain, ALICE, 0);
    }

    // resolveWithRedirects — hop cap reverts before following one too many.
    function test_ResolveWithRedirects_HopCap_Reverts() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        bytes32 c = keccak256("C");
        _redirect(keccak256("rAB"), a, b, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);
        _redirect(keccak256("rBC"), b, c, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);

        bytes32[] memory chain = new bytes32[](2);
        chain[0] = keccak256("rAB");
        chain[1] = keccak256("rBC");
        // Cap of 1 allows the first hop, reverts on attempting the second.
        vm.expectRevert(abi.encodeWithSelector(EFSReader.RedirectHopLimit.selector, uint256(1)));
        this.resolveWithRedirectsExt(a, chain, ALICE, 1);
    }

    // resolveWithRedirects — a chain hop whose source != cursor reverts (broken chain).
    function test_ResolveWithRedirects_BrokenChain_Reverts() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        bytes32 x = keccak256("X"); // unrelated source
        bytes32 c = keccak256("C");
        _redirect(keccak256("rAB"), a, b, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);
        // Second redirect's source is X, not B — does not connect to the cursor at B.
        _redirect(keccak256("rXC"), x, c, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);

        bytes32[] memory chain = new bytes32[](2);
        chain[0] = keccak256("rAB");
        chain[1] = keccak256("rXC");
        vm.expectRevert(
            abi.encodeWithSelector(EFSReader.RedirectChainBroken.selector, b, keccak256("rXC"))
        );
        this.resolveWithRedirectsExt(a, chain, ALICE, 0);
    }

    // resolveWithRedirects — lens scoping: Alice's chain is invisible to Bob's lens.
    function test_ResolveWithRedirects_LensScoped() public {
        bytes32 src = keccak256("dataDup");
        bytes32 canon = keccak256("dataCanon");
        bytes32 rUID = keccak256("r1");
        _redirect(rUID, src, canon, EFSReader.REDIRECT_KIND_SAME_AS, ALICE);

        bytes32[] memory chain = new bytes32[](1);
        chain[0] = rUID;

        // Alice (the asserter) follows to canonical.
        (bytes32 aliceTerminal,) =
            EFSReader.resolveWithRedirects(_eas(), REDIRECT_SCHEMA, src, chain, ALICE, 0);
        assertEq(aliceTerminal, canon, "Alice's lens follows her redirect");

        // Bob does not see Alice's redirect — passthrough to source.
        (bytes32 bobTerminal, uint256 bobHops) =
            EFSReader.resolveWithRedirects(_eas(), REDIRECT_SCHEMA, src, chain, BOB, 0);
        assertEq(bobTerminal, src, "Bob's lens does not follow Alice's redirect");
        assertEq(bobHops, 0, "Bob follows nothing");
    }
}
