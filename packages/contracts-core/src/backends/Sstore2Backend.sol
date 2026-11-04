// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {IStorageBackend} from "../interfaces/IStorageBackend.sol";
import {CodeStore} from "../utils/CodeStore.sol";

/// @title Sstore2Backend
/// @notice An ABX FS storage backend that keeps each input as contract code (SSTORE2) and returns it unchanged.
///         EVM-readable. Identical input is stored once (see `CodeStore`). The input cap is the EIP-170 code limit
///         minus the leading STOP byte, a constant so the backend has the same address on every chain; a chain with
///         a larger code limit can use another backend at its own address.
contract Sstore2Backend is IStorageBackend {
    error InputSize(uint256 size);
    error NoData(bytes32 pointer);

    uint256 public constant MAX_INPUT_SIZE = CodeStore.MAX_DATA;

    /// @inheritdoc IStorageBackend
    function store(bytes calldata input, address) external returns (bytes32 pointer) {
        uint256 n = input.length;
        if (n == 0 || n > MAX_INPUT_SIZE) revert InputSize(n);
        pointer = bytes32(uint256(uint160(CodeStore.place(input))));
    }

    /// @inheritdoc IStorageBackend
    function readable() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IStorageBackend
    function retrieve(bytes32 pointer) external view virtual returns (bytes memory) {
        return _stored(pointer);
    }

    /// @inheritdoc IStorageBackend
    function retrieval() external pure virtual returns (bytes32 scheme, string memory instructions) {
        return ("evm", "EVM-readable: ChunkStore.read(id), or retrieve(pointer) on this contract.");
    }

    /// @inheritdoc IStorageBackend
    function maxInputSize() external pure returns (uint256) {
        return MAX_INPUT_SIZE;
    }

    /// @dev The bytes stored at `pointer`. Reverts `NoData` for anything that is not an address holding code.
    function _stored(bytes32 pointer) internal view returns (bytes memory) {
        address p = address(uint160(uint256(pointer)));
        if (uint256(pointer) >> 160 != 0 || p.code.length == 0) revert NoData(pointer);
        return SSTORE2.read(p);
    }
}
