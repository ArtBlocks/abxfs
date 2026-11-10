// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ContentReader} from "./ContentReader.sol";

/// @title AbxContentReader
/// @notice A fixed ABX FS source implementing ABX's read(address) on-chain metadata reader ABI.
/// @dev Use abi.encode(address(this), address(this)) as the ABX reader representation. The pointer
///      names this immutable source configuration; it cannot redirect reads through a mutable contract.
contract AbxContentReader {
    ContentReader public immutable reader;
    bytes32 public immutable root;
    uint256 public immutable maxBytes;
    uint256 public immutable maxChunks;
    string public path;

    error InvalidPointer(address pointer);

    constructor(address reader_, bytes32 root_, string memory path_, uint256 maxBytes_, uint256 maxChunks_) {
        reader = ContentReader(reader_);
        root = root_;
        path = path_;
        maxBytes = maxBytes_;
        maxChunks = maxChunks_;
    }

    function read(address pointer) external view returns (bytes memory data) {
        if (pointer != address(this)) revert InvalidPointer(pointer);
        (, data) = reader.readPath(root, path, maxBytes, maxChunks);
    }
}
