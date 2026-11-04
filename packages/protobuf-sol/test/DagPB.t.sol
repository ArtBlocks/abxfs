// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DagPB} from "../src/DagPB.sol";
import {CID} from "../src/CID.sol";
import {UnixFS} from "../src/UnixFS.sol";

contract DagPBTest is Test {
    function test_EncodeSingleLink() public pure {
        bytes32 h = 0x5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03;
        DagPB.Link memory link = DagPB.Link({
            hash: CID.binary(CID.CODEC_RAW, h),
            name: "a.txt",
            tsize: 5
        });
        bytes memory out = DagPB.encodeLink(link);
        // Expected: 0a 24 01551220<h> 12 05 "a.txt" 18 05
        bytes memory want = bytes.concat(
            hex"0a240155122058",
            hex"91b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
            hex"1205612e7478741805"
        );
        assertEq(out, want);
    }

    function test_PbNodeEncodingLinksBeforeData() public pure {
        // Single PBLink + UnixFS directory data. Confirms "Links (field 2) encoded BEFORE Data (field 1)".
        bytes32 xHash = 0x2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881;

        DagPB.Link[] memory links = new DagPB.Link[](1);
        links[0] = DagPB.Link({
            hash: CID.binary(CID.CODEC_RAW, xHash),
            name: "x",
            tsize: 1
        });

        bytes memory node = DagPB.encodeNode(links, UnixFS.directoryData());

        // The first byte MUST be 0x12 (field 2, length-delimited = Links), NOT 0x0a (field 1 = Data).
        assertEq(uint8(node[0]), 0x12);

        // Full match (fixture: one-file-dir).
        assertEq(
            node,
            hex"122b0a24015512202d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a488112017818010a020801"
        );
    }

    /// A node with no links is only its Data field, and a node with no data is only its links (the data field is
    /// left out, not written empty); with neither it is empty.
    function test_EncodeNode_EmptyParts() public pure {
        bytes32 h = 0x2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881;
        DagPB.Link[] memory none = new DagPB.Link[](0);
        assertEq(DagPB.encodeNode(none, UnixFS.directoryData()), hex"0a020801");
        assertEq(DagPB.encodeNode(none, ""), "");

        DagPB.Link[] memory one = new DagPB.Link[](1);
        one[0] = DagPB.Link({hash: CID.binary(CID.CODEC_RAW, h), name: "x", tsize: 1});
        bytes memory linkOnly = DagPB.encodeNode(one, "");
        assertEq(linkOnly, hex"122b0a24015512202d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a48811201781801");
        // the same node with data is the link bytes followed by the Data field
        assertEq(DagPB.encodeNode(one, UnixFS.directoryData()), bytes.concat(linkOnly, hex"0a020801"));
    }

    /// A link without a name still writes the empty Name field (file roots link their blocks this way); a Tsize of 0
    /// is written, not left out.
    function test_EncodeLink_EmptyNameAndZeroTsize() public pure {
        bytes32 h = 0x5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03;
        DagPB.Link memory link = DagPB.Link({hash: CID.binary(CID.CODEC_RAW, h), name: "", tsize: 0});
        assertEq(
            DagPB.encodeLink(link),
            bytes.concat(hex"0a24", CID.binary(CID.CODEC_RAW, h), hex"1200", hex"1800")
        );
    }
}
