// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibZip} from "solady/utils/LibZip.sol";

import {Sstore2Backend} from "./Sstore2Backend.sol";

/// @title FastLzSstore2Backend
/// @notice An ABX FS storage backend that keeps FastLZ-compressed input as contract code (SSTORE2) and inflates it on
///         every read with Solady's `LibZip.flzDecompress`, so the chain itself returns the chunk's data. EVM-readable.
///
/// @dev    `ChunkStore` reads every chunk back through `retrieve` when it is written, so a stream that does not
///         inflate to the claimed data is never recorded. FastLZ references at most 8 KiB back, so compressing each
///         chunk on its own costs little against compressing a whole file. A chunk's data size is on its record, so
///         readers can refuse an oversized expansion before reading it.
contract FastLzSstore2Backend is Sstore2Backend {
    /// @inheritdoc Sstore2Backend
    function retrieve(bytes32 pointer) external view override returns (bytes memory) {
        return LibZip.flzDecompress(_stored(pointer));
    }

    /// @inheritdoc Sstore2Backend
    function retrieval() external pure override returns (bytes32 scheme, string memory instructions) {
        return ("evm", "EVM-readable: ChunkStore.read(id). Stored as FastLZ (Solady LibZip); retrieve(pointer) inflates.");
    }
}
