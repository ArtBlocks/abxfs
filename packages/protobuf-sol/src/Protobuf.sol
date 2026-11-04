// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Protobuf
/// @notice Minimal protobuf encoder sufficient for dag-pb / UnixFS.
///         Only the wire types and fields required by IPFS are implemented.
library Protobuf {
    /// @dev Protobuf wire types.
    uint8 internal constant WIRE_VARINT = 0;
    uint8 internal constant WIRE_LENGTH_DELIMITED = 2;

    /// @dev Encode a varint into a fresh bytes buffer.
    function encodeVarint(uint256 value) internal pure returns (bytes memory out) {
        // Up to 10 bytes: enough for any value below 2^70, so any uint64. Larger values overflow the buffer and revert.
        bytes memory scratch = new bytes(10);
        uint256 n;
        while (value >= 0x80) {
            scratch[n++] = bytes1(uint8((value & 0x7F) | 0x80));
            value >>= 7;
        }
        scratch[n++] = bytes1(uint8(value));

        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = scratch[i];
        }
    }

    /// @dev Number of bytes a varint will consume.
    function varintSize(uint256 value) internal pure returns (uint256 n) {
        do {
            n++;
            value >>= 7;
        } while (value != 0);
    }

    /// @dev Encode the field tag (field_number << 3 | wire_type) as varint.
    function encodeTag(uint256 fieldNumber, uint8 wireType) internal pure returns (bytes memory) {
        return encodeVarint((fieldNumber << 3) | uint256(wireType));
    }

    /// @dev Encode a length-delimited field: [tag][len][value].
    function encodeLengthDelimited(uint256 fieldNumber, bytes memory value) internal pure returns (bytes memory) {
        bytes memory tag = encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED);
        bytes memory len = encodeVarint(value.length);
        return bytes.concat(tag, len, value);
    }

    /// @dev Encode a varint field: [tag][varint(value)].
    function encodeVarintField(uint256 fieldNumber, uint256 value) internal pure returns (bytes memory) {
        bytes memory tag = encodeTag(fieldNumber, WIRE_VARINT);
        bytes memory v = encodeVarint(value);
        return bytes.concat(tag, v);
    }

    // ------------------------------------------------------------------
    // Decoders (used only for tests).
    // ------------------------------------------------------------------

    /// @dev Decode a varint starting at `offset`. Returns value and new offset.
    function decodeVarint(bytes memory data, uint256 offset) internal pure returns (uint256 value, uint256 newOffset) {
        uint256 shift;
        while (true) {
            require(offset < data.length, "varint: truncated");
            uint8 b = uint8(data[offset++]);
            value |= uint256(b & 0x7F) << shift;
            if (b & 0x80 == 0) break;
            shift += 7;
            require(shift < 64, "varint: overflow");
        }
        newOffset = offset;
    }
}
