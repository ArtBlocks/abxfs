// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

/// @title CodeStore
/// @notice Keeps bytes as contract code in Solady's SSTORE2 layout (`0x00 ‖ data`: a leading STOP so the code can
///         never run), deployed with one CREATE2 whose init code carries the data. `SSTORE2.read` reads it back.
///
/// @dev    Placement tries the salts 0, 1, …, 7 in turn. An address that already holds exactly `0x00 ‖ data` is
///         reused: CREATE2 commits to the init code, so only this deployer could have put that code there. An
///         address that holds anything else is skipped. That only happens if someone controls an account at the
///         CREATE2 address of data they chose (a key found by about 2^80 work, then an EIP-7702 delegation); skipping it
///         means such an account cannot stop that data being stored.
///
///         Occupancy is checked before deploying because a CREATE2 into an occupied address does not fail cheaply:
///         it consumes 63/64 of the remaining gas. An account's nonce cannot be read from the EVM, so an account with
///         a nonce but no code looks free, and deploying onto it reverts the whole call. That also needs the 2^80
///         attack and only denies the one data string it targets.
library CodeStore {
    /// @notice `data` is empty or larger than one contract can hold.
    error DataSize(uint256 size);
    /// @notice Every candidate address holds foreign code.
    error NoFreeAddress();

    /// @dev EIP-170's 24,576-byte code limit, minus the STOP byte.
    uint256 internal constant MAX_DATA = 24_575;
    uint256 internal constant ATTEMPTS = 8;

    /// @notice Store `data` as code and return where it lives (a reused address if `data` is already stored).
    function place(bytes memory data) internal returns (address pointer) {
        uint256 n = data.length;
        if (n == 0 || n > MAX_DATA) revert DataSize(n);
        bytes32 initHash = SSTORE2.initCodeHash(data);
        bytes32 codeHash;
        for (uint256 i; i < ATTEMPTS;) {
            bytes32 salt = bytes32(i);
            pointer = predict(initHash, salt, address(this));
            if (pointer.code.length == 0) return SSTORE2.writeCounterfactual(data, salt);
            if (codeHash == bytes32(0)) codeHash = keccak256(abi.encodePacked(bytes1(0x00), data));
            if (pointer.codehash == codeHash) return pointer;
            unchecked {
                ++i;
            }
        }
        revert NoFreeAddress();
    }

    /// @notice The CREATE2 address `deployer` uses for init code hashing to `initHash` under `salt`.
    function predict(bytes32 initHash, bytes32 salt, address deployer) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash)))));
    }
}
