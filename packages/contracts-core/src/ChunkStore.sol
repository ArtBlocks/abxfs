// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Multicallable} from "solady/utils/Multicallable.sol";

import {IChunkStore} from "./interfaces/IChunkStore.sol";
import {IStorageBackend} from "./interfaces/IStorageBackend.sol";

/// @title ChunkStore
/// @notice ABX FS chunk records. Any contract can be a backend; the backend's address, the hash of the input it was given and the
///         chunk's data hash and size are all inside the chunk id (see `IChunkStore`). No owner, no registry, no ETH.
///
/// @dev    Of the ABX FS contracts, this is the only one that calls a backend. `write` uses typed calls, so a reverting or malformed
///         backend fails only the write that chose it. `read` uses a raw `staticcall`, copies nothing larger than the
///         record says, and decodes the result by hand, so a misbehaving backend yields `RetrieveFailed` or `DataMismatch`,
///         never a bare decoding revert. Inherits Solady `Multicallable`, which refuses ETH.
contract ChunkStore is IChunkStore, Multicallable {
    bytes1 internal constant _CHUNK_PREFIX = 0x30;

    /// @dev Three slots; backend and size share the first. The input's hash is part of the id but is not kept: `read`
    ///      needs only these, and the `ChunkWritten` event carries it for anyone recomputing ids from logs.
    struct Record {
        address backend;
        uint48 size;
        bytes32 pointer;
        bytes32 dataHash;
    }

    mapping(bytes32 => Record) internal _records;

    /// @inheritdoc IChunkStore
    function write(address backend, bytes calldata input, bytes32 dataHash, uint48 size) external returns (bytes32 id) {
        if (backend.code.length == 0) revert InvalidBackend(backend);
        if (size == 0) revert EmptyChunk();
        bytes32 inputHash = keccak256(input);
        id = chunkId(backend, inputHash, dataHash, size);
        if (_records[id].backend != address(0)) return id;

        bytes32 pointer = IStorageBackend(backend).store(input, msg.sender);
        // The backend may have re-entered and recorded this very id; that record stands.
        if (_records[id].backend != address(0)) return id;

        if (IStorageBackend(backend).readable()) {
            bytes memory data = IStorageBackend(backend).retrieve(pointer);
            if (data.length != size || keccak256(data) != dataHash) revert DataMismatch(id);
        }

        _records[id] = Record({backend: backend, size: size, pointer: pointer, dataHash: dataHash});
        emit ChunkWritten(id, backend, pointer, inputHash, dataHash, size);
    }

    /// @inheritdoc IChunkStore
    function chunkId(address backend, bytes32 inputHash, bytes32 dataHash, uint48 size) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_CHUNK_PREFIX, backend, inputHash, dataHash, size));
    }

    /// @inheritdoc IChunkStore
    function read(bytes32 id) external view returns (bytes memory data) {
        Record storage r = _records[id];
        address backend = r.backend;
        if (backend == address(0)) revert ChunkNotFound(id);
        uint256 size = r.size;
        bytes32 pointer = r.pointer;
        bytes4 selector = IStorageBackend.retrieve.selector;

        // One ABI-encoded `bytes` of `size` bytes is an offset word, a length word and the data padded to a word.
        bool ok;
        uint256 returned;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, selector)
            mstore(add(m, 0x04), pointer)
            ok := staticcall(gas(), backend, m, 0x24, 0x00, 0x00)
            returned := returndatasize()
        }
        if (!ok || returned < 0x40 + size || returned > 0x40 + ((size + 0x1f) & ~uint256(0x1f))) {
            revert RetrieveFailed(id, backend);
        }
        uint256 offset;
        uint256 length;
        assembly ("memory-safe") {
            returndatacopy(0x00, 0x00, 0x40)
            offset := mload(0x00)
            length := mload(0x20)
        }
        if (offset != 0x20) revert RetrieveFailed(id, backend);
        if (length != size) revert DataMismatch(id);
        data = new bytes(size);
        assembly ("memory-safe") {
            returndatacopy(add(data, 0x20), 0x40, size)
        }
        if (keccak256(data) != r.dataHash) revert DataMismatch(id);
    }

    /// @inheritdoc IChunkStore
    function exists(bytes32 id) external view returns (bool) {
        return _records[id].backend != address(0);
    }

    /// @inheritdoc IChunkStore
    function sizeOf(bytes32 id) external view returns (uint48) {
        return _record(id).size;
    }

    /// @inheritdoc IChunkStore
    function recordOf(bytes32 id)
        external
        view
        returns (address backend, uint48 size, bytes32 pointer, bytes32 dataHash)
    {
        Record memory r = _record(id);
        return (r.backend, r.size, r.pointer, r.dataHash);
    }

    function _record(bytes32 id) internal view returns (Record memory r) {
        r = _records[id];
        if (r.backend == address(0)) revert ChunkNotFound(id);
    }
}
