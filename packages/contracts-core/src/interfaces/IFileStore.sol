// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IChunkStore} from "./IChunkStore.sol";

/// @title IFileStore
/// @notice Immutable, content-addressed ABX FS files: a tree of chunk nodes (at most three branch levels above its
///         leaves) over `ChunkStore` chunks, a MIME type, and an optional off-chain codec. A file's data is its
///         chunks' data joined in order; with a codec, its content is `decode(codec, data)` and readers check it
///         against `outputHash`. A zero root is the empty file. See `specs/abx-fs.md` §5 and §6.
interface IFileStore {
    struct FileInfo {
        bytes32 root;
        uint8 rootLevel;
        uint256 chunkCount;
        /// @dev Total bytes of the joined chunk data (before any file-level codec is decoded).
        uint256 size;
        string mimeType;
        bytes32 codec;
        bytes32 outputHash;
    }

    /// @notice Create (or return the existing) chunk node: a leaf of `chunkId:32 ‖ size:6` records or a branch.
    function putChunkNode(bytes calldata blob) external returns (bytes32 nodeId);

    /// @notice Bind a file. `mimeType` is 1..127 bytes. `codec` and `outputHash` are both zero or both set.
    ///         `rootNode == 0` is the empty file, which takes no codec.
    function createFile(bytes32 rootNode, string calldata mimeType, bytes32 codec, bytes32 outputHash)
        external
        returns (bytes32 cid);

    /// @notice `keccak256(0x31 ‖ rootNode ‖ keccak256(mimeType) ‖ codec ‖ outputHash)`.
    function fileCid(bytes32 rootNode, string calldata mimeType, bytes32 codec, bytes32 outputHash)
        external
        pure
        returns (bytes32 cid);

    function chunkStore() external view returns (IChunkStore);

    function fileExists(bytes32 cid) external view returns (bool);

    function getFileInfo(bytes32 cid) external view returns (FileInfo memory info);

    function chunkCount(bytes32 cid) external view returns (uint256);

    function getChunkId(bytes32 cid, uint256 index) external view returns (bytes32 id);

    /// @notice Chunk ids in `[start, end)`. Callers page.
    function getChunkIds(bytes32 cid, uint256 start, uint256 end) external view returns (bytes32[] memory ids);

    /// @notice The chunk holding byte `offset` of the file's data: its index, the offset of its first byte, its id
    ///         and its size.
    function locateByte(bytes32 cid, uint256 offset)
        external
        view
        returns (uint256 index, uint256 chunkStart, bytes32 chunkId, uint256 chunkSize);

    /// @notice One chunk's data, through `ChunkStore.read`.
    function readChunk(bytes32 cid, uint256 index) external view returns (bytes memory data);
}
