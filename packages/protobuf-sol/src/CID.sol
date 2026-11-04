// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Protobuf} from "./Protobuf.sol";

/// @title CID
/// @notice CIDv1 binary construction + RFC 4648 lowercase base32 ("b" multibase) encoding.
///         Uses sha2-256 (multihash code 0x12, length 0x20).
library CID {
    uint256 internal constant CODEC_RAW = 0x55;
    uint256 internal constant CODEC_DAG_PB = 0x70;

    uint8 internal constant MULTIHASH_SHA256 = 0x12;
    uint8 internal constant MULTIHASH_SHA256_LEN = 0x20;

    /// @dev Build the binary CIDv1 for sha2-256: 0x01 ‖ varint(codec) ‖ 0x12 ‖ 0x20 ‖ hash (36 bytes for a one-byte
    ///      codec such as raw or dag-pb).
    function binary(uint256 codec, bytes32 hash) internal pure returns (bytes memory out) {
        bytes memory codecVarint = Protobuf.encodeVarint(codec);
        uint256 k = codecVarint.length;
        out = new bytes(3 + k + 32);
        assembly ("memory-safe") {
            let p := add(out, 0x20)
            mstore8(p, 0x01) // CIDv1
            mcopy(add(p, 1), add(codecVarint, 0x20), k)
            mstore8(add(p, add(k, 1)), MULTIHASH_SHA256)
            mstore8(add(p, add(k, 2)), MULTIHASH_SHA256_LEN)
            // The hash ends exactly at the end of `out`.
            mstore(add(p, add(k, 3)), hash)
        }
    }

    /// @dev Encode `data` as lowercase RFC 4648 base32 (no padding) with a "b" multibase prefix. Five bytes at a time
    ///      become eight symbols; a last group of fewer bytes is read with zero bits after its end, and only the
    ///      symbols its bits reach are kept.
    function base32Multibase(bytes memory data) internal pure returns (string memory out) {
        uint256 n = data.length;
        uint256 len = 1 + (n * 8 + 4) / 5; // "b", then ceil(8n / 5) symbols
        assembly ("memory-safe") {
            out := mload(0x40)
            // At least one spare word past the string: the last group may write up to six symbols beyond `len`.
            mstore(0x40, add(out, and(add(len, 0x5f), not(0x1f))))
            mstore(out, len)
            let dst := add(out, 0x20)
            mstore8(dst, 0x62) // "b"
            dst := add(dst, 1)
            // byte i of this word is the symbol for the value i
            let alphabet := "abcdefghijklmnopqrstuvwxyz234567"
            let src := add(data, 0x20)
            let end := add(src, n)
            for {} lt(src, end) {} {
                // the next five bytes, as a 40-bit number
                let v := shr(216, mload(src))
                let rest := sub(end, src)
                // past the end of `data`, zero bits
                if lt(rest, 5) { v := and(v, not(sub(shl(mul(sub(5, rest), 8), 1), 1))) }
                for { let j := 0 } lt(j, 8) { j := add(j, 1) } {
                    mstore8(add(dst, j), byte(and(shr(sub(35, mul(j, 5)), v), 0x1f), alphabet))
                }
                src := add(src, 5)
                dst := add(dst, 8)
            }
            // Zero whatever the last group wrote past the string (the word after it is still allocated).
            mstore(add(add(out, 0x20), len), 0)
        }
    }

    /// @dev Convenience: full CIDv1 base32 string from codec + hash.
    function encode(uint256 codec, bytes32 hash) internal pure returns (string memory) {
        return base32Multibase(binary(codec, hash));
    }
}
