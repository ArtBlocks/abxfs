// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NameOps
/// @notice Directory entry names, 32 bytes at a time: unsigned byte-order comparison and the separator check.
library NameOps {
    /// @notice Unsigned byte-lexicographic compare, a shorter prefix first: -1, 0 or 1.
    /// @dev    Big-endian words compare like their bytes. The last partial word is shifted down to the bytes both
    ///         names still have, so nothing past the shorter name is compared.
    function compare(bytes memory a, bytes memory b) internal pure returns (int256 r) {
        assembly ("memory-safe") {
            let la := mload(a)
            let lb := mload(b)
            let min := la
            if lt(lb, la) { min := lb }
            let pa := add(a, 0x20)
            let pb := add(b, 0x20)
            for { let i := 0 } lt(i, min) { i := add(i, 0x20) } {
                let wa := mload(add(pa, i))
                let wb := mload(add(pb, i))
                let rem := sub(min, i)
                if lt(rem, 0x20) {
                    let sh := shl(3, sub(0x20, rem))
                    wa := shr(sh, wa)
                    wb := shr(sh, wb)
                }
                if iszero(eq(wa, wb)) {
                    r := sub(gt(wa, wb), lt(wa, wb))
                    break
                }
            }
            if iszero(r) { r := sub(gt(la, lb), lt(la, lb)) }
        }
    }

    /// @notice Whether `b` holds a `/` or a `\`.
    /// @dev    A byte of `w ^ c` is zero exactly where `w` holds `c`, and the zero-byte test below has no false
    ///         positives (no carry crosses a byte). The bytes past the end of the last word are set to 0x01, which is
    ///         neither separator.
    function hasSeparator(bytes calldata b) internal pure returns (bool found) {
        assembly ("memory-safe") {
            let ones := 0x0101010101010101010101010101010101010101010101010101010101010101
            let lows := 0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f
            let slash := mul(0x2f, ones)
            let back := mul(0x5c, ones)
            let len := b.length
            for { let i := 0 } lt(i, len) { i := add(i, 0x20) } {
                let w := calldataload(add(b.offset, i))
                let rem := sub(len, i)
                if lt(rem, 0x20) {
                    let keep := not(sub(shl(shl(3, sub(0x20, rem)), 1), 1))
                    w := or(and(w, keep), and(ones, not(keep)))
                }
                let x := xor(w, slash)
                let y := xor(w, back)
                let zx := not(or(or(add(and(x, lows), lows), x), lows))
                let zy := not(or(or(add(and(y, lows), lows), y), lows))
                if or(zx, zy) {
                    found := 1
                    break
                }
            }
        }
    }
}
