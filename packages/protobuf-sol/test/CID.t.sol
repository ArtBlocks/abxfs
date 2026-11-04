// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CID} from "../src/CID.sol";

contract CIDTest is Test {
    function test_Binary_Raw() public pure {
        bytes32 h = 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;
        bytes memory bin = CID.binary(CID.CODEC_RAW, h);
        assertEq(
            bin,
            hex"01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    function test_Binary_DagPb() public pure {
        bytes32 h = 0x3713b02b19e84cfe3795aa63b1e428291c27192d34702809b1c762dd4dcc3ad8;
        bytes memory bin = CID.binary(CID.CODEC_DAG_PB, h);
        assertEq(
            bin,
            hex"017012203713b02b19e84cfe3795aa63b1e428291c27192d34702809b1c762dd4dcc3ad8"
        );
    }

    function test_Base32_EmptyRaw() public pure {
        bytes32 h = 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;
        string memory cid = CID.encode(CID.CODEC_RAW, h);
        assertEq(cid, "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    }

    function test_Base32_HelloRaw() public pure {
        bytes32 h = 0x5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03;
        string memory cid = CID.encode(CID.CODEC_RAW, h);
        assertEq(cid, "bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am");
    }

    function test_Base32_DirectoryDagPb() public pure {
        bytes32 h = 0x3713b02b19e84cfe3795aa63b1e428291c27192d34702809b1c762dd4dcc3ad8;
        string memory cid = CID.encode(CID.CODEC_DAG_PB, h);
        assertEq(cid, "bafybeibxcoycwgpijt7dpfnkmoy6ikbjdqtrsljuoauatmohmlou3tb23a");
    }

    /// RFC 4648 section 10 test vectors, lowercased, unpadded, behind the "b" multibase prefix. Between them they take
    /// every tail: 0 bytes (nothing to encode), and 1 to 5 bytes (8, 16, 24, 32 and 40 data bits, the last with no
    /// leftover bits and so no padded final group).
    function test_Base32_Rfc4648Vectors() public pure {
        assertEq(CID.base32Multibase(""), "b");
        assertEq(CID.base32Multibase("f"), "bmy");
        assertEq(CID.base32Multibase("fo"), "bmzxq");
        assertEq(CID.base32Multibase("foo"), "bmzxw6");
        assertEq(CID.base32Multibase("foob"), "bmzxw6yq");
        assertEq(CID.base32Multibase("fooba"), "bmzxw6ytb");
        assertEq(CID.base32Multibase("foobar"), "bmzxw6ytboi");
    }

    /// Both ends of the alphabet, a padded last group, and every table entry in order.
    function test_Base32_AlphabetEnds() public pure {
        // five zero bytes are eight groups of 0; five 0xff bytes eight groups of 31
        assertEq(CID.base32Multibase(hex"0000000000"), "baaaaaaaa");
        assertEq(CID.base32Multibase(hex"ffffffffff"), "b77777777");
        // a lone byte pads its second group with zero bits: 11111 111(00) = 31, 28 -> "7" "4"
        assertEq(CID.base32Multibase(hex"ff"), "b74");
        // twenty bytes holding the groups 0, 1, ..., 31 come out as the alphabet, in order
        assertEq(
            CID.base32Multibase(hex"00443214c74254b635cf84653a56d7c675be77df"), "babcdefghijklmnopqrstuvwxyz234567"
        );
    }

    /// A codec whose varint is longer than one byte widens the CID: 0x0129 (dag-json) is the varint `a9 02`.
    function test_Binary_MultiByteCodec() public pure {
        bytes32 h = 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;
        bytes memory bin = CID.binary(0x0129, h);
        assertEq(bin.length, 37);
        assertEq(bin, hex"01a9021220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assertEq(CID.encode(0x0129, h), CID.base32Multibase(bin));
    }

    // ---- the assembly encoder against two references -------------------

    /// Any input, of any length (every tail of 0 to 4 bytes after the full five-byte groups), encodes as both the
    /// bit-by-bit reference and the byte loop the library used before it was written in assembly. The string is
    /// zero-padded to its word, and nothing allocated afterwards overlaps it.
    function testFuzz_Base32_MatchesReferences(bytes memory data) public pure {
        string memory got = CID.base32Multibase(data);
        string memory want = _bitByBit(data);
        assertEq(got, want, "bit-by-bit reference");
        assertEq(got, string(abi.encodePacked("b", _byteLoop(data))), "byte-loop reference");
        // The same bytes followed in memory by set bits rather than fresh zeros, as in memory an arena has released:
        // the encoder reads whole words, so only its masking keeps those bits out of the last group.
        assertEq(CID.base32Multibase(_dirtyTail(data)), want, "bits after the data are ignored");
        // the bytes after the string, to the end of its last word, are zero
        uint256 len = bytes(got).length;
        uint256 pad = (32 - len % 32) % 32;
        uint256 tail;
        assembly ("memory-safe") {
            tail := mload(add(add(got, 0x20), len))
        }
        assertEq(tail >> (8 * (32 - pad)), 0, "padding");
        // an allocation right after it does not overlap it
        bytes memory after_ = new bytes(64);
        for (uint256 i; i < 64; i++) after_[i] = 0xff;
        assertEq(got, want, "unchanged by the next allocation");
    }

    /// The CID of any codec (one-byte varints and longer) and digest: the binary form against `abi.encodePacked`, and
    /// the string against the bit-by-bit reference over it.
    function testFuzz_Encode_MatchesReference(uint64 codec, bytes32 h) public pure {
        bytes memory bin = abi.encodePacked(uint8(1), _varint(codec), uint8(0x12), uint8(0x20), h);
        assertEq(CID.binary(codec, h), bin, "binary");
        assertEq(CID.encode(codec, h), _bitByBit(bin), "string");
    }

    /// The two codecs ABX FS uses, with digests whose bits fall on every symbol boundary, encoded in memory that earlier
    /// use left set (the resolver encodes after releasing its arenas).
    function testFuzz_Encode_RawAndDagPb(bytes32 h, bool dagPb) public pure {
        uint256 codec = dagPb ? CID.CODEC_DAG_PB : CID.CODEC_RAW;
        assembly ("memory-safe") {
            let p := mload(0x40)
            for { let i := 0 } lt(i, 0x400) { i := add(i, 0x20) } { mstore(add(p, i), not(0)) }
        }
        string memory s = CID.encode(codec, h);
        assertEq(bytes(s).length, 59, "36 bytes are 58 symbols after the prefix");
        assertEq(s, _bitByBit(abi.encodePacked(uint8(1), uint8(codec), uint8(0x12), uint8(0x20), h)));
    }

    /// @dev RFC 4648 base32 by the definition: the input as one bit string, cut into 5-bit groups from the front, the
    ///      last padded with zero bits.
    function _bitByBit(bytes memory data) internal pure returns (string memory) {
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        bytes memory out = new bytes(1 + (data.length * 8 + 4) / 5);
        out[0] = "b";
        for (uint256 i; i + 1 < out.length; i++) {
            uint256 v;
            for (uint256 k; k < 5; k++) {
                uint256 bit = i * 5 + k;
                uint256 b = bit / 8 < data.length ? (uint8(data[bit / 8]) >> (7 - (bit % 8))) & 1 : 0;
                v = (v << 1) | b;
            }
            out[i + 1] = alphabet[v];
        }
        return string(out);
    }

    /// @dev The library's encoder before it was written in assembly (a bit buffer, a byte at a time), kept verbatim.
    function _byteLoop(bytes memory data) internal pure returns (bytes memory out) {
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        uint256 n = data.length;
        if (n == 0) return new bytes(0);
        uint256 outLen = (n * 8 + 4) / 5; // ceil
        out = new bytes(outLen);
        uint256 buffer;
        uint256 bits;
        uint256 idx;
        for (uint256 i = 0; i < n; i++) {
            buffer = (buffer << 8) | uint8(data[i]);
            bits += 8;
            while (bits >= 5) {
                bits -= 5;
                uint256 val = (buffer >> bits) & 0x1F;
                out[idx++] = alphabet[val];
            }
        }
        if (bits > 0) {
            uint256 val = (buffer << (5 - bits)) & 0x1F;
            out[idx++] = alphabet[val];
        }
    }

    /// @dev A copy of `data` whose memory continues with 64 bytes of 0xff.
    function _dirtyTail(bytes memory data) internal pure returns (bytes memory out) {
        uint256 n = data.length;
        out = new bytes(n + 64);
        for (uint256 i; i < n + 64; i++) out[i] = i < n ? data[i] : bytes1(0xff);
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// @dev Unsigned LEB128, seven bits at a time from the low end.
    function _varint(uint256 v) internal pure returns (bytes memory out) {
        while (v >= 0x80) {
            out = abi.encodePacked(out, uint8(v & 0x7f) | 0x80);
            v >>= 7;
        }
        out = abi.encodePacked(out, uint8(v));
    }
}
