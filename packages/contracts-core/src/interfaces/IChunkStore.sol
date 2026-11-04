// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IChunkStore
/// @notice Content-addressed chunk records for ABX FS. A chunk's id binds the backend that holds it, the exact input
///         given to that backend, and the hash and size of the chunk's data (what the backend's `retrieve` returns,
///         or what a reader obtains by following the backend's retrieval scheme):
///
///             id = keccak256(0x30 ‖ backend:20 ‖ keccak256(input):32 ‖ dataHash:32 ‖ size:6)
///
///         For a readable backend the chain checks `dataHash` and `size` when the chunk is written and on every read.
///         For any other backend they are claims bound into the id: a false claim yields an id no honest writer
///         would compute, so it can never occupy anyone else's chunk. See `specs/abx-fs.md` §4.
interface IChunkStore {
    error InvalidBackend(address backend);
    error EmptyChunk();
    error DataMismatch(bytes32 id);
    error ChunkNotFound(bytes32 id);
    /// @notice The backend's `retrieve` reverted, or its return data is not shaped like one ABI-encoded `bytes` of the
    ///         recorded size (an offset other than 0x20, or too short or too long for that size). Ask that backend's
    ///         `retrieval()` how to fetch the bytes instead. A well-shaped result whose length or hash disagrees with the
    ///         record is `DataMismatch`.
    error RetrieveFailed(bytes32 id, address backend);

    event ChunkWritten(
        bytes32 indexed id, address indexed backend, bytes32 pointer, bytes32 inputHash, bytes32 dataHash, uint48 size
    );

    /// @notice Store `input` through `backend` and record the chunk. Returns the existing id without calling the
    ///         backend when the chunk is already recorded.
    function write(address backend, bytes calldata input, bytes32 dataHash, uint48 size) external returns (bytes32 id);

    /// @notice The chunk id for these parts (see the notice above).
    function chunkId(address backend, bytes32 inputHash, bytes32 dataHash, uint48 size)
        external
        pure
        returns (bytes32 id);

    /// @notice The chunk's data, checked against its record. Reverts `RetrieveFailed` when the backend cannot serve it.
    function read(bytes32 id) external view returns (bytes memory data);

    function exists(bytes32 id) external view returns (bool);

    /// @notice The recorded size of the chunk's data. Reverts `ChunkNotFound` if the id is not recorded.
    function sizeOf(bytes32 id) external view returns (uint48 size);

    /// @notice The whole record. Reverts `ChunkNotFound` if the id is not recorded.
    function recordOf(bytes32 id) external view returns (address backend, uint48 size, bytes32 pointer, bytes32 dataHash);
}
