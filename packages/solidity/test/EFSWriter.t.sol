// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EFSWriter} from "../src/EFSWriter.sol";
import {EFSLib} from "../src/EFSLib.sol";

/// @dev A minimal consumer that inherits the base, used to assert the inline pattern.
contract ConsumerMock is EFSWriter {
    function read(string memory path) external view returns (bool, bytes32) {
        return _efsRead(path);
    }
}

contract EFSWriterTest is Test {
    ConsumerMock consumer;

    function setUp() public {
        consumer = new ConsumerMock();
    }

    /// @notice Scaffold guard: stubs revert with NotImplemented until the build lands.
    function test_ReadRevertsNotImplemented() public {
        vm.expectRevert(EFSLib.NotImplemented.selector);
        consumer.read("/hello.txt");
    }

    // TODO(build): once EFSLib reads/writes are real, assert msg.sender survives
    // library inlining — vm.prank(alice); consumer.pin(...); assertEq(attester, alice);
}
