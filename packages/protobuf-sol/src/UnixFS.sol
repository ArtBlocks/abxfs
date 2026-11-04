// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Protobuf} from "./Protobuf.sol";

/// @title UnixFS
/// @notice Minimal UnixFS data message builders (file + directory).
///
/// @dev UnixFS data message (inside dag-pb node's Data field):
///        field 1 (Type, varint)  - 2 = File, 1 = Directory
///        field 2 (Data, bytes)   - inline file data (only for tiny files)
///        field 3 (filesize, u64) - file size (only for file type)
///        field 4 (blocksizes, repeated u64) - file-data bytes under each child link
library UnixFS {
    uint256 internal constant TYPE_FILE = 2;
    uint256 internal constant TYPE_DIRECTORY = 1;

    /// @dev Directory: { Type: 1 }.
    function directoryData() internal pure returns (bytes memory) {
        return Protobuf.encodeVarintField(1, TYPE_DIRECTORY);
    }

    /// @dev File without inline data or blocksizes: { Type: 2, filesize: size }. Not what the ABX FS
    ///      profile emits for a multi-block root, which also carries `blocksizes` (see
    ///      `fileDataWithBlocksizes`).
    function fileData(uint256 filesize) internal pure returns (bytes memory) {
        bytes memory a = Protobuf.encodeVarintField(1, TYPE_FILE);
        bytes memory b = Protobuf.encodeVarintField(3, filesize);
        return bytes.concat(a, b);
    }

    /// @dev File with inline data (rare in practice, provided for completeness):
    ///      { Type: 2, Data: <bytes>, filesize: |bytes| }.
    function inlineFileData(bytes memory data) internal pure returns (bytes memory) {
        bytes memory a = Protobuf.encodeVarintField(1, TYPE_FILE);
        bytes memory b = Protobuf.encodeLengthDelimited(2, data);
        bytes memory c = Protobuf.encodeVarintField(3, data.length);
        return bytes.concat(a, b, c);
    }

    /// @dev Multi-block file root UnixFS data:
    ///      { Type: 2, filesize: total, blocksizes: [size_per_child, ...] }.
    ///      Field encoding order matches Kubo and `ipfs-unixfs-importer`: Type (1), filesize (3),
    ///      blocksizes (4, repeated). Each blocksize corresponds to a child link
    ///      in the same order as PBLinks in the enclosing PBNode.
    function fileDataWithBlocksizes(uint256 filesize, uint256[] memory blocksizes)
        internal
        pure
        returns (bytes memory out)
    {
        out = Protobuf.encodeVarintField(1, TYPE_FILE);
        out = bytes.concat(out, Protobuf.encodeVarintField(3, filesize));
        for (uint256 i = 0; i < blocksizes.length; i++) {
            out = bytes.concat(out, Protobuf.encodeVarintField(4, blocksizes[i]));
        }
    }
}
