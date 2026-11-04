// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {NameOps} from "../src/utils/NameOps.sol";

/// @dev The word-at-a-time `NameOps` against the byte loops `DirectoryStore` used before it. Any disagreement would
///      change which directories are accepted or how names sort, so both are fuzzed against a byte-by-byte reference.
contract NameOpsHarness {
    function compare(bytes memory a, bytes memory b) external pure returns (int256) {
        return NameOps.compare(a, b);
    }

    function hasSeparator(bytes calldata b) external pure returns (bool) {
        return NameOps.hasSeparator(b);
    }

    function refCompare(bytes memory a, bytes memory b) external pure returns (int256) {
        uint256 min = a.length < b.length ? a.length : b.length;
        for (uint256 i = 0; i < min; i++) {
            if (a[i] != b[i]) return uint8(a[i]) < uint8(b[i]) ? -int256(1) : int256(1);
        }
        if (a.length == b.length) return 0;
        return a.length < b.length ? -int256(1) : int256(1);
    }

    function refHasSeparator(bytes calldata b) external pure returns (bool) {
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == "/" || b[i] == "\\") return true;
        }
        return false;
    }
}

contract NameOpsTest is Test {
    NameOpsHarness internal h = new NameOpsHarness();

    /// @dev `b` shares a prefix of `a`, then diverges or stops, so equal-prefix and partial-word cases are common.
    function _mutate(bytes memory a, uint256 seed) internal pure returns (bytes memory b) {
        uint256 cut = a.length == 0 ? 0 : seed % (a.length + 1);
        uint256 extra = (seed >> 16) % 40;
        b = new bytes(cut + extra);
        for (uint256 i; i < cut; i++) {
            b[i] = a[i];
        }
        for (uint256 i; i < extra; i++) {
            b[cut + i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i)))));
        }
    }

    function testFuzz_compareMatchesReference(bytes memory a, uint256 seed) public view {
        vm.assume(a.length <= 300);
        bytes memory b = _mutate(a, seed);
        assertEq(h.compare(a, b), h.refCompare(a, b));
        assertEq(h.compare(b, a), h.refCompare(b, a));
        assertEq(h.compare(a, a), 0);
    }

    function testFuzz_hasSeparatorMatchesReference(bytes memory a, uint16 pos, uint8 which) public view {
        assertEq(h.hasSeparator(a), h.refHasSeparator(a));
        if (a.length > 0) {
            // The separators, their neighbours and bytes with the high bit set near them.
            uint8[7] memory bytes_ = [0x2f, 0x5c, 0x2e, 0x00, 0xaf, 0xdc, 0x2e];
            a[pos % a.length] = bytes1(bytes_[which % 7]);
            assertEq(h.hasSeparator(a), h.refHasSeparator(a));
        }
    }

    /// @dev A separator at every position of names that end inside, at, and just past a word boundary.
    function test_hasSeparator_everyPosition() public view {
        uint256[6] memory lens = [uint256(1), 31, 32, 33, 64, 255];
        for (uint256 l; l < lens.length; l++) {
            bytes memory name = new bytes(lens[l]);
            for (uint256 i; i < name.length; i++) {
                name[i] = 0x2e;
            }
            assertFalse(h.hasSeparator(name));
            for (uint256 i; i < name.length; i++) {
                name[i] = "/";
                assertTrue(h.hasSeparator(name));
                name[i] = "\\";
                assertTrue(h.hasSeparator(name));
                name[i] = 0x2e;
            }
        }
        assertFalse(h.hasSeparator(""));
    }

    function test_compare_edges() public view {
        assertEq(h.compare("", ""), 0);
        assertEq(h.compare("", "a"), -1);
        assertEq(h.compare("a", ""), 1);
        assertEq(h.compare(hex"ff", hex"00"), 1);
        assertEq(h.compare(hex"00", hex"0000"), -1);
        bytes memory a = new bytes(64);
        bytes memory b = new bytes(64);
        b[63] = 0x01;
        assertEq(h.compare(a, b), -1);
        b[63] = 0x00;
        b[32] = 0x80;
        assertEq(h.compare(b, a), 1);
    }
}
