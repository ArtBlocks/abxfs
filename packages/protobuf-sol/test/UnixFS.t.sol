// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {UnixFS} from "../src/UnixFS.sol";
import {DagPB} from "../src/DagPB.sol";
import {CID} from "../src/CID.sol";
import {Protobuf} from "../src/Protobuf.sol";

contract UnixFSTest is Test {
    function test_DirectoryData() public pure {
        // { Type: 1 } => tag 0x08 (field 1, varint) + varint(1)
        assertEq(UnixFS.directoryData(), hex"0801");
    }

    function test_FileData_ZeroSize() public pure {
        // { Type: 2, filesize: 0 }
        assertEq(UnixFS.fileData(0), hex"08021800");
    }

    function test_FileData_KbSize() public pure {
        // filesize = 1024 => varint 8008
        assertEq(UnixFS.fileData(1024), hex"080218" hex"8008");
    }

    function test_InlineFileData() public pure {
        // { Type: 2, Data: "hi", filesize: 2 } => 0802 12 02 6869 18 02
        assertEq(UnixFS.inlineFileData(bytes("hi")), hex"08021202686918" hex"02");
    }

    // ------------------------------------------------------------------
    // Multi-block file roots.
    // ------------------------------------------------------------------

    function test_FileDataWithBlocksizes() public pure {
        uint256[] memory bs = new uint256[](2);
        bs[0] = 262_144;
        bs[1] = 1024;
        // { Type: 2, filesize: 263168, blocksizes: [262144, 1024] } = 0802 | 18 808810 | 20 808010 | 20 8008
        assertEq(UnixFS.fileDataWithBlocksizes(263_168, bs), hex"0802" hex"18808810" hex"20808010" hex"208008");
    }

    function test_FileDataWithBlocksizes_Edges() public pure {
        uint256[] memory none = new uint256[](0);
        // no blocksizes is exactly `fileData`
        assertEq(UnixFS.fileDataWithBlocksizes(0, none), UnixFS.fileData(0));
        assertEq(UnixFS.fileDataWithBlocksizes(1024, none), UnixFS.fileData(1024));
        // one child, a blocksize under 128 is a single byte, one at 128 is two
        uint256[] memory one = new uint256[](1);
        one[0] = 127;
        assertEq(UnixFS.fileDataWithBlocksizes(127, one), hex"0802" hex"187f" hex"207f");
        one[0] = 128;
        assertEq(UnixFS.fileDataWithBlocksizes(128, one), hex"0802" hex"188001" hex"208001");
        // blocksizes keep the order given, repeats included
        uint256[] memory three = new uint256[](3);
        (three[0], three[1], three[2]) = (5, 5, 2);
        assertEq(UnixFS.fileDataWithBlocksizes(12, three), hex"0802" hex"180c" hex"2005" hex"2005" hex"2002");
    }

    /// The two multi-block fixtures from the IPFS reference libraries: the UnixFS data is the tail of each PBNode, and
    /// rebuilding the whole node (links from the fixture's own link hashes, empty names, the chunk sizes as Tsize,
    /// then the data) and hashing it gives the fixture's digest and CID.
    function test_FileDataWithBlocksizes_FixtureParity() public view {
        string memory json = vm.readFile("test/fixtures/multi-block-files.json");
        uint256 checked;
        for (uint256 i = 0; i < 16; i++) {
            string memory at = string.concat(".[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, at)) break;
            _checkFixture(json, at);
            checked++;
        }
        assertEq(checked, 2, "both fixtures");
    }

    function _checkFixture(string memory json, string memory at) private view {
        uint256[] memory sizes = vm.parseJsonUintArray(json, string.concat(at, ".chunk_sizes"));
        uint256 size = vm.parseJsonUint(json, string.concat(at, ".size"));
        bytes memory pbnode = vm.parseJsonBytes(json, string.concat(at, ".pbnode_hex"));
        bytes memory data = UnixFS.fileDataWithBlocksizes(size, sizes);

        // the Data field closes the node
        bytes memory dataField = Protobuf.encodeLengthDelimited(1, data);
        for (uint256 k = 0; k < dataField.length; k++) {
            assertEq(pbnode[pbnode.length - dataField.length + k], dataField[k], "data field");
        }

        // links: each is 0x12 0x2c, 0x0a 0x24 <36-byte raw cid>, 0x12 0x00, 0x18 <tsize> (a 3-byte tsize here)
        DagPB.Link[] memory links = new DagPB.Link[](sizes.length);
        uint256 at0;
        for (uint256 j = 0; j < sizes.length; j++) {
            bytes memory h = new bytes(36);
            for (uint256 k = 0; k < 36; k++) {
                h[k] = pbnode[at0 + 4 + k];
            }
            links[j] = DagPB.Link({hash: h, name: "", tsize: sizes[j]});
            at0 += 2 + uint8(pbnode[at0 + 1]);
        }
        assertEq(at0 + dataField.length, pbnode.length, "links and data fill the node");
        bytes memory rebuilt = DagPB.encodeNode(links, data);
        assertEq(rebuilt, pbnode, "whole node");

        bytes32 digest = sha256(rebuilt);
        assertEq(digest, vm.parseJsonBytes32(json, string.concat(at, ".sha256_hex")), "digest");
        assertEq(CID.encode(CID.CODEC_DAG_PB, digest), vm.parseJsonString(json, string.concat(at, ".cid")), "cid");
    }
}
