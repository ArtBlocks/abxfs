// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NameOps} from "../src/utils/NameOps.sol";

/// NameOps.t.sol calls `hasSeparator` on a whole ABI argument, whose tail is zero padding, and
/// `compare` on freshly decoded (zero-padded) memory. In DirectoryStore the name is a slice of the leaf blob followed
/// by the flag and CID bytes, so these drive the tail mask and the partial-word shift with hostile bytes after the end.
contract NameOpsTailHarness {
    function hasSeparatorIn(bytes calldata buf, uint256 len) external pure returns (bool) {
        return NameOps.hasSeparator(buf[:len]);
    }

    /// `a` and `b` truncated in place to `la` / `lb`: the bytes after each end stay in memory.
    function compareTruncated(bytes memory a, uint256 la, bytes memory b, uint256 lb) external pure returns (int256) {
        assembly {
            mstore(a, la)
            mstore(b, lb)
        }
        return NameOps.compare(a, b);
    }
}

contract NameOpsTailTest is Test {
    NameOpsTailHarness internal h = new NameOpsTailHarness();

    function _ref(bytes memory b, uint256 len) internal pure returns (bool) {
        for (uint256 i; i < len; i++) if (b[i] == "/" || b[i] == "\\") return true;
        return false;
    }

    function _refCmp(bytes memory a, uint256 la, bytes memory b, uint256 lb) internal pure returns (int256) {
        uint256 min = la < lb ? la : lb;
        for (uint256 i; i < min; i++) {
            if (a[i] != b[i]) return uint8(a[i]) < uint8(b[i]) ? -int256(1) : int256(1);
        }
        if (la == lb) return 0;
        return la < lb ? -int256(1) : int256(1);
    }

    /// Every name length 1..255, followed by 32 separators: never a separator inside the name.
    function test_separatorsAfterTheEndAreIgnored() public view {
        for (uint256 len = 1; len <= 255; len++) {
            for (uint256 k; k < 2; k++) {
                bytes memory buf = new bytes(len + 32);
                for (uint256 i; i < len; i++) buf[i] = "a";
                for (uint256 i = len; i < len + 32; i++) buf[i] = k == 0 ? bytes1("/") : bytes1("\\");
                assertFalse(h.hasSeparatorIn(buf, len));
            }
        }
    }

    function testFuzz_sliceTail(bytes memory buf, uint256 len, uint8 fill) public view {
        len = bound(len, 0, buf.length);
        bytes memory b = bytes.concat(buf, new bytes(40));
        for (uint256 i = buf.length; i < b.length; i++) b[i] = fill % 2 == 0 ? bytes1("/") : bytes1("\\");
        for (uint256 i = len; i < buf.length; i++) b[i] = fill % 3 == 0 ? bytes1("/") : b[i];
        assertEq(h.hasSeparatorIn(b, len), _ref(b, len));
    }

    function testFuzz_compareIgnoresBytesAfterTheEnd(bytes memory a, bytes memory b, uint256 la, uint256 lb) public view {
        la = bound(la, 0, a.length);
        lb = bound(lb, 0, b.length);
        assertEq(h.compareTruncated(a, la, b, lb), _refCmp(a, la, b, lb));
    }

    /// A shared prefix inside one word, then different bytes past both ends.
    function test_compareSharedPrefixDirtyTails() public view {
        bytes memory a = hex"6161616100ff";
        bytes memory b = hex"61616161ff00";
        assertEq(h.compareTruncated(a, 4, b, 4), 0);
        assertEq(h.compareTruncated(a, 4, b, 5), -1);
        assertEq(h.compareTruncated(a, 5, b, 4), 1);
    }

    /// Every shorter length 1..64 (each partial-word width, and one full word), equal up to it, with hostile bytes
    /// right past it: the partial-word shift is exercised at every width, rem == 31 included.
    function test_compareDirtyByteAfterEveryLength() public view {
        for (uint256 len = 1; len <= 64; len++) {
            bytes memory a = new bytes(len + 1);
            bytes memory b = new bytes(len + 1);
            for (uint256 i; i < len; i++) {
                a[i] = "x";
                b[i] = "x";
            }
            a[len] = 0xff;
            b[len] = 0x00;
            assertEq(h.compareTruncated(a, len, b, len), 0, "same name");
            assertEq(h.compareTruncated(a, len, b, len + 1), -1, "a prefix sorts first");
            assertEq(h.compareTruncated(b, len + 1, a, len), 1, "a longer name sorts after its prefix");
        }
    }
}
