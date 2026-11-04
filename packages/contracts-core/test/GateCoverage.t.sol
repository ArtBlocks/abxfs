// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DriftedDeploy} from "./Deploy.t.sol";
import {GateHarness} from "./DeployGateFork.t.sol";

/// The refusal path in any build mode (optimized or `forge coverage`). ChunkStore is the first field
/// `requirePinned` compares, so a drift there is named "ChunkStore" whether or not the rest of the build is pinned.
contract GateCoverageTest is Test {
    function test_aDriftedFirstContractIsRefusedOffLocalInEveryBuildMode() public {
        Deploy d = new DriftedDeploy(Deploy.Contract.ChunkStore, false);
        vm.chainId(8453);
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.UnexpectedAddress.selector, "ChunkStore", d.predict().chunkStore, d.pinned().chunkStore)
        );
        d.run();
    }
}


/// How `vm.rpc` returns an `eth_chainId` answer (the quantity's big-endian bytes, leading zeros as sent), read by the
/// one rule both deploy scripts share. Only 31337 is local; with no fork at all, the chain is local (nothing can be
/// broadcast).
contract LocalChainTest is Test {
    function test_onlyAnAnswerOf31337IsLocal() public {
        GateHarness h = new GateHarness();
        assertTrue(h.answersLocal(hex"7a69"));
        assertTrue(h.answersLocal(hex"00007a69"));
        assertTrue(h.answersLocal(abi.encodePacked(bytes12(0), uint160(31_337))));
        assertTrue(h.answersLocal(abi.encode(uint256(31_337))));
        assertFalse(h.answersLocal(hex"014a34"), "84532");
        assertFalse(h.answersLocal(hex"2105"), "8453");
        assertFalse(h.answersLocal(hex""), "no answer");
        assertFalse(h.answersLocal(bytes.concat(hex"00", abi.encode(uint256(31_337)))), "longer than a word");
        assertFalse(h.answersLocal(hex"7a6900"), "a trailing zero is another number");
    }

    function test_withNoForkTheChainIsLocalAndWithoutOverrideItIsNot() public {
        GateHarness h = new GateHarness();
        vm.chainId(8453);
        assertFalse(h.isLocal(), "a chain id other than 31337 is never local");
        vm.chainId(31_337);
        assertTrue(h.isLocal(), "31337 with no RPC: nothing can be broadcast");
    }
}
