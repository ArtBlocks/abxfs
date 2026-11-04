// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ProjectHook} from "../src/ProjectHook.sol";
import {MockStore} from "./mocks/Mocks.sol";

/// @dev The Solidity half of a cross-language guard. ABX packs short param keys into `bytes32` as
///      left-aligned ASCII rather than hashing them, so `bytes32("abxfs.cid")` here must be
///      byte-identical to `stringToHex(key, { size: 32 })` in the SDK. Divergence is SILENT: every
///      read returns "unset" and every write lands on a key nobody reads.
///
///      The same literals are asserted from TypeScript in
///      `packages/sdk/test/project-keys.test.ts`. Regenerate with `cast format-bytes32-string`.
contract ParamKeysTest is Test {
    ProjectHook internal hook;

    function setUp() public {
        hook = new ProjectHook(address(new MockStore()), address(new MockStore()), address(0));
    }

    function test_KeyBytesArePinned() public view {
        assertEq(
            hook.KEY_CID(),
            bytes32(0x61627866732e6369640000000000000000000000000000000000000000000000),
            "abxfs.cid"
        );
        assertEq(
            hook.KEY_GATEWAY(),
            bytes32(0x61627866732e6761746577617900000000000000000000000000000000000000),
            "abxfs.gateway"
        );
        assertEq(
            hook.KEY_NAME(),
            bytes32(0x61627866732e6e616d6500000000000000000000000000000000000000000000),
            "abxfs.name"
        );
        assertEq(
            hook.KEY_VIEW(),
            bytes32(0x61627866732e7669657700000000000000000000000000000000000000000000),
            "abxfs.view"
        );
        assertEq(
            hook.KEY_META(),
            bytes32(0x61627866732e6d65746100000000000000000000000000000000000000000000),
            "abxfs.meta"
        );
    }

    /// @dev Keys are readable ASCII on-chain, not digests — that is the property the packing buys.
    function test_KeysArePackedAsciiNotHashed() public view {
        assertEq(hook.KEY_CID(), bytes32("abxfs.cid"));
        assertTrue(hook.KEY_CID() != keccak256("abxfs.cid"));
    }
}
