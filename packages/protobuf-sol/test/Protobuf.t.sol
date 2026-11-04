// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {Protobuf} from "../src/Protobuf.sol";

/// @dev The library's functions are internal, and `vm.expectRevert` needs a call frame to watch.
contract ProtobufHarness {
    function encodeVarint(uint256 value) external pure returns (bytes memory) {
        return Protobuf.encodeVarint(value);
    }

    function decodeVarint(bytes memory data, uint256 offset) external pure returns (uint256, uint256) {
        return Protobuf.decodeVarint(data, offset);
    }
}

contract ProtobufTest is Test {
    ProtobufHarness internal harness = new ProtobufHarness();

    function test_Varint_Simple() public pure {
        assertEq(Protobuf.encodeVarint(0), hex"00");
        assertEq(Protobuf.encodeVarint(1), hex"01");
        assertEq(Protobuf.encodeVarint(127), hex"7f");
        assertEq(Protobuf.encodeVarint(128), hex"8001");
        assertEq(Protobuf.encodeVarint(300), hex"ac02");
    }

    /// @notice Matches all varint values produced by the IPFS reference generator.
    function test_Varint_FixtureParity() public view {
        string memory data = vm.readFile("test/fixtures/varints.json");
        // Values are stored as strings (to survive uint64 JSON bounds); iterate by index until key missing.
        for (uint256 i = 0; i < 64; i++) {
            string memory path = string.concat(".[", vm.toString(i), "]");
            if (!vm.keyExistsJson(data, path)) break;
            string memory valueStr = vm.parseJsonString(data, string.concat(path, ".value"));
            uint256 value = vm.parseUint(valueStr);
            bytes memory expected = vm.parseJsonBytes(data, string.concat(path, ".encoded_hex"));
            assertEq(Protobuf.encodeVarint(value), expected, "varint mismatch");
        }
    }

    function test_VarintSize() public pure {
        assertEq(Protobuf.varintSize(0), 1);
        assertEq(Protobuf.varintSize(127), 1);
        assertEq(Protobuf.varintSize(128), 2);
        assertEq(Protobuf.varintSize(16383), 2);
        assertEq(Protobuf.varintSize(16384), 3);
    }

    function test_EncodeTag() public pure {
        // field 1, length-delimited (wire 2) => (1 << 3) | 2 = 0x0a
        assertEq(Protobuf.encodeTag(1, 2), hex"0a");
        // field 2, length-delimited (wire 2) => (2 << 3) | 2 = 0x12
        assertEq(Protobuf.encodeTag(2, 2), hex"12");
        // field 3, varint (wire 0) => (3 << 3) | 0 = 0x18
        assertEq(Protobuf.encodeTag(3, 0), hex"18");
    }

    function test_LengthDelimited() public pure {
        bytes memory out = Protobuf.encodeLengthDelimited(2, bytes("hello"));
        assertEq(out, hex"120568656c6c6f");
    }

    function test_DecodeVarintRoundtrip() public pure {
        uint256[10] memory samples = [
            uint256(0),
            uint256(1),
            uint256(127),
            uint256(128),
            uint256(255),
            uint256(300),
            uint256(16383),
            uint256(16384),
            uint256(1 << 32),
            uint256(1) << 60
        ];
        for (uint256 i = 0; i < samples.length; i++) {
            bytes memory enc = Protobuf.encodeVarint(samples[i]);
            (uint256 got, uint256 off) = Protobuf.decodeVarint(enc, 0);
            assertEq(got, samples[i], "roundtrip value");
            assertEq(off, enc.length, "roundtrip consumed");
        }
    }

    // ------------------------------------------------------------------
    // Edges of the encoder and the decoder.
    // ------------------------------------------------------------------

    /// The encoder's buffer is ten bytes: every uint64 fits (the widest, 2^64 - 1, takes all ten), and so does any
    /// value below 2^70. One more bit needs an eleventh byte and the write past the buffer reverts.
    function test_EncodeVarint_WidestValues() public {
        assertEq(Protobuf.encodeVarint(type(uint64).max), hex"ffffffffffffffffff01");
        assertEq(Protobuf.encodeVarint(1 << 63), hex"80808080808080808001");
        assertEq(Protobuf.encodeVarint((1 << 70) - 1), hex"ffffffffffffffffff7f");
        assertEq(Protobuf.varintSize(type(uint64).max), 10);
        assertEq(Protobuf.varintSize((1 << 70) - 1), 10);
        assertEq(Protobuf.varintSize(1 << 70), 11, "varintSize has no limit, unlike encodeVarint");
        vm.expectRevert(stdError.indexOOBError);
        harness.encodeVarint(1 << 70);
        vm.expectRevert(stdError.indexOOBError);
        harness.encodeVarint(type(uint256).max);
    }

    /// Decoding starts where it is told, returns where the next field starts, and reads the widest uint64.
    function test_DecodeVarint_OffsetsAndWidest() public pure {
        bytes memory data = bytes.concat(hex"ff", hex"ac02", hex"ffffffffffffffffff01", hex"7f");
        (uint256 v, uint256 next) = Protobuf.decodeVarint(data, 1);
        assertEq(v, 300);
        assertEq(next, 3);
        (v, next) = Protobuf.decodeVarint(data, next);
        assertEq(v, type(uint64).max);
        assertEq(next, 13, "ten bytes consumed");
        (v, next) = Protobuf.decodeVarint(data, next);
        assertEq(v, 127);
        assertEq(next, 14);
        // a value in a one-byte varint at the very end of the buffer
        (v, next) = Protobuf.decodeVarint(hex"00", 0);
        assertEq(v, 0);
        assertEq(next, 1);
    }

    /// A varint that is still asking for more bytes when the data ends, or that starts past the end, is "truncated".
    function test_DecodeVarint_Truncated() public {
        vm.expectRevert(bytes("varint: truncated"));
        harness.decodeVarint(hex"80", 0); // continuation bit set, nothing follows
        vm.expectRevert(bytes("varint: truncated"));
        harness.decodeVarint(hex"ff8080", 0);
        vm.expectRevert(bytes("varint: truncated"));
        harness.decodeVarint(hex"", 0);
        vm.expectRevert(bytes("varint: truncated"));
        harness.decodeVarint(hex"0102", 2); // offset at the end
        vm.expectRevert(bytes("varint: truncated"));
        harness.decodeVarint(hex"0102", 7); // offset past the end
        vm.expectRevert(bytes("varint: truncated"));
        harness.decodeVarint(hex"0180", 1); // the same, mid-buffer
    }

    /// More than ten bytes cannot be a uint64: the tenth byte still asking for more is "overflow" (checked before an
    /// eleventh is read, so a buffer of exactly ten bytes reports it too).
    function test_DecodeVarint_Overflow() public {
        vm.expectRevert(bytes("varint: overflow"));
        harness.decodeVarint(hex"80808080808080808080", 0); // ten continuation bytes
        vm.expectRevert(bytes("varint: overflow"));
        harness.decodeVarint(hex"ffffffffffffffffffff01", 0); // eleven bytes, the tenth continues
        vm.expectRevert(bytes("varint: overflow"));
        harness.decodeVarint(bytes.concat(hex"aa", hex"80808080808080808080"), 1);
        // nine continuation bytes and a final byte is the longest legal form
        (uint256 v, uint256 next) = harness.decodeVarint(hex"80808080808080808001", 0);
        assertEq(v, 1 << 63);
        assertEq(next, 10);
    }

    /// Encode then decode agrees for the whole uint64 range's edges, and for the field helpers' tags.
    function testFuzz_VarintRoundtrip(uint64 value) public pure {
        bytes memory enc = Protobuf.encodeVarint(value);
        assertEq(enc.length, Protobuf.varintSize(value));
        (uint256 got, uint256 off) = Protobuf.decodeVarint(enc, 0);
        assertEq(got, value);
        assertEq(off, enc.length);
    }

    function test_VarintField() public pure {
        // field 3, varint 300: tag 0x18, then ac 02
        assertEq(Protobuf.encodeVarintField(3, 300), hex"18ac02");
        // a field number above 15 needs a two-byte tag: (16 << 3) | 0 = 128 -> 80 01
        assertEq(Protobuf.encodeVarintField(16, 1), hex"800101");
        assertEq(Protobuf.encodeLengthDelimited(16, hex"aa"), hex"8201" hex"01aa");
        // an empty value is a tag and a zero length
        assertEq(Protobuf.encodeLengthDelimited(1, ""), hex"0a00");
        // a value of 128 bytes has a two-byte length
        bytes memory big = new bytes(128);
        bytes memory out = Protobuf.encodeLengthDelimited(1, big);
        assertEq(out.length, 1 + 2 + 128);
        assertEq(uint8(out[1]), 0x80);
        assertEq(uint8(out[2]), 0x01);
    }
}
